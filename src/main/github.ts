import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import type { PluginConnectionState } from '../shared.ts'

type GhResult = { stdout: string; stderr: string }
type GhRunner = (args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<GhResult>

const MAX_OUTPUT = 18_000
const defaultRunner: GhRunner = (args, options = {}) => new Promise((resolve, reject) => {
  execFile(resolveGitHubCliExecutable(), args, {
    cwd: options.cwd,
    timeout: options.timeoutMs || 30_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }))
})

export function resolveGitHubCliExecutable(
  platform = process.platform,
  isExecutable: (path: string) => boolean = executableFile,
) {
  if (platform !== 'darwin') return 'gh'
  for (const path of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    if (isExecutable(path)) return path
  }
  return 'gh'
}

function executableFile(path: string) {
  try { accessSync(path, constants.X_OK); return true } catch { return false }
}

export class GitHubCliService {
  private readonly run: GhRunner
  constructor(run: GhRunner = defaultRunner) { this.run = run }

  async state(): Promise<PluginConnectionState> {
    try {
      const value = await this.json(['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'])
      const account = value?.hosts?.['github.com']?.find((item: any) => item?.active && item?.state === 'success')
      return account
        ? { connected: true, status: 'connected', account: String(account.login || ''), message: `Connected as ${String(account.login || 'GitHub user')}` }
        : { connected: false, status: 'disconnected', message: 'GitHub CLI is installed but not signed in.' }
    } catch (error) {
      return missingGh(error)
        ? { connected: false, status: 'unavailable', message: 'GitHub CLI is not installed.' }
        : { connected: false, status: 'disconnected', message: ghError(error) }
    }
  }

  async connect(): Promise<PluginConnectionState> {
    try {
      await this.run(['auth', 'login', '--hostname', 'github.com', '--web', '--skip-ssh-key'], { timeoutMs: 15 * 60_000 })
      return this.state()
    } catch (error) {
      return missingGh(error)
        ? { connected: false, status: 'unavailable', message: 'GitHub CLI is not installed.' }
        : { connected: false, status: 'error', message: ghError(error) }
    }
  }

  async repository(cwd: string, repo?: string) {
    try {
      return await this.json(['repo', 'view', ...repoArgs(repo), '--json', 'nameWithOwner,url,description,defaultBranchRef,isPrivate,viewerPermission'], cwd)
    } catch (error) {
      if (!repo && /not a git repository/i.test(ghError(error))) return {
        available: false,
        reason: 'This task has no Git repository. Use github_repo_list to list repositories for the signed-in GitHub account, or pass repo as owner/name.',
      }
      throw error
    }
  }

  async repositories(options: { owner?: string; visibility?: string; limit?: number } = {}) {
    const requestedLimit = limit(options.limit), args = ['repo', 'list']
    if (options.owner) args.push(accountName(options.owner))
    args.push('--limit', String(requestedLimit))
    if (options.visibility) args.push('--visibility', enumValue(options.visibility, ['public', 'private', 'internal'], 'public'))
    args.push('--json', 'nameWithOwner,url,description,isPrivate,isFork,isArchived,visibility,primaryLanguage,updatedAt')
    const repositories = await this.json(args)
    return boundedRepositories(Array.isArray(repositories) ? repositories : [], requestedLimit)
  }

  async pullRequests(cwd: string, options: { repo?: string; state?: string; limit?: number } = {}) {
    return this.json(['pr', 'list', ...repoArgs(options.repo), '--state', enumValue(options.state, ['open', 'closed', 'merged', 'all'], 'open'), '--limit', String(limit(options.limit)), '--json', 'number,title,state,isDraft,author,headRefName,baseRefName,url,updatedAt'], cwd)
  }

  async pullRequest(cwd: string, number: number, repo?: string) {
    return this.json(['pr', 'view', integer(number, 'pull request number'), ...repoArgs(repo), '--json', 'number,title,state,isDraft,author,body,baseRefName,headRefName,url,mergeable,reviewDecision,statusCheckRollup,files,reviews,comments'], cwd)
  }

  async createPullRequest(cwd: string, options: { repo?: string; title: string; body?: string; base?: string; head?: string; draft?: boolean }) {
    const args = ['pr', 'create', ...repoArgs(options.repo), '--title', boundedInput(options.title, 256, 'title'), '--body', boundedInput(options.body || '', 20_000, 'body')]
    if (options.base) args.push('--base', gitRef(options.base))
    if (options.head) args.push('--head', gitRef(options.head))
    if (options.draft) args.push('--draft')
    const { stdout } = await this.run(args, { cwd, timeoutMs: 60_000 })
    return bounded(stdout.trim() || 'Pull request created.')
  }

  async issues(cwd: string, options: { repo?: string; state?: string; limit?: number } = {}) {
    return this.json(['issue', 'list', ...repoArgs(options.repo), '--state', enumValue(options.state, ['open', 'closed', 'all'], 'open'), '--limit', String(limit(options.limit)), '--json', 'number,title,state,author,labels,assignees,url,updatedAt'], cwd)
  }

  async checks(cwd: string, options: { repo?: string; branch?: string; limit?: number } = {}) {
    const args = ['run', 'list', ...repoArgs(options.repo), '--limit', String(limit(options.limit)), '--json', 'databaseId,name,workflowName,status,conclusion,event,headBranch,headSha,url,createdAt,updatedAt']
    if (options.branch) args.push('--branch', gitRef(options.branch))
    return this.json(args, cwd)
  }

  private async json(args: string[], cwd?: string): Promise<any> {
    let output: GhResult
    try { output = await this.run(args, { cwd }) }
    catch (error) {
      if (missingGh(error)) throw error
      if (!/TLS handshake timeout|connection reset|temporary failure/i.test(ghError(error))) throw Error(ghError(error))
      try { output = await this.run(args, { cwd, timeoutMs: 45_000 }) } catch (retryError) { throw Error(ghError(retryError)) }
    }
    const { stdout } = output
    try { return JSON.parse(stdout) } catch { throw Error(`GitHub CLI returned invalid JSON: ${bounded(stdout)}`) }
  }
}

function repoArgs(repo?: string) { return repo ? ['--repo', repositoryName(repo)] : [] }
function repositoryName(value: string) {
  const repo = String(value || '').trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw Error('GitHub repository must use owner/name format.')
  return repo
}
function accountName(value: string) {
  const account = String(value || '').trim()
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/.test(account)) throw Error('GitHub owner must be a user or organization login.')
  return account
}
function gitRef(value: string) {
  const ref = String(value || '').trim()
  if (!ref || ref.length > 255 || /[\u0000-\u001f\u007f]/.test(ref)) throw Error('Invalid Git ref.')
  return ref
}
function limit(value?: number) { return Math.min(100, Math.max(1, Math.floor(Number(value) || 20))) }
function integer(value: number, label: string) {
  const number = Math.floor(Number(value))
  if (!Number.isSafeInteger(number) || number < 1) throw Error(`Invalid ${label}.`)
  return String(number)
}
function enumValue(value: string | undefined, allowed: string[], fallback: string) {
  return allowed.includes(String(value || '')) ? String(value) : fallback
}
function boundedInput(value: string, max: number, label: string) {
  const text = String(value || '')
  if (!text.trim()) throw Error(`GitHub ${label} is required.`)
  if (text.length > max) throw Error(`GitHub ${label} is too long.`)
  return text
}
function bounded(value: string) { return value.length <= MAX_OUTPUT ? value : `${value.slice(0, MAX_OUTPUT - 40)}\n[truncated by GitHub tool boundary]` }
function boundedRepositories(values: any[], requestedLimit: number) {
  const repositories: any[] = []
  for (const value of values) {
    const item = {
      nameWithOwner: String(value?.nameWithOwner || ''),
      url: String(value?.url || ''),
      description: String(value?.description || '').slice(0, 280),
      visibility: String(value?.visibility || (value?.isPrivate ? 'PRIVATE' : 'PUBLIC')),
      isPrivate: Boolean(value?.isPrivate),
      isFork: Boolean(value?.isFork),
      isArchived: Boolean(value?.isArchived),
      primaryLanguage: value?.primaryLanguage?.name ? String(value.primaryLanguage.name) : undefined,
      updatedAt: String(value?.updatedAt || ''),
    }
    if (JSON.stringify({ repositories: [...repositories, item] }).length > MAX_OUTPUT) break
    repositories.push(item)
  }
  return {
    repositories,
    returned: repositories.length,
    truncated: repositories.length < values.length || values.length === requestedLimit,
  }
}
function missingGh(error: unknown) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function ghError(error: unknown) {
  const value = error as { stderr?: string; message?: string }
  return bounded(String(value.stderr || value.message || error || 'GitHub CLI failed.').trim())
}
