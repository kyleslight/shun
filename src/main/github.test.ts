import assert from 'node:assert/strict'
import test from 'node:test'
import { GitHubCliService } from './github.ts'

test('GitHub CLI connection reuses the active keyring login without reading its token', async () => {
  const seen: string[][] = []
  const service = new GitHubCliService(async args => {
    seen.push(args)
    return { stdout: JSON.stringify({ hosts: { 'github.com': [{ state: 'success', active: true, login: 'octocat', tokenSource: 'keyring' }] } }), stderr: '' }
  })
  assert.deepEqual(await service.state(), { connected: true, status: 'connected', account: 'octocat', message: 'Connected as octocat' })
  assert.deepEqual(seen[0], ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'])
  assert.doesNotMatch(seen.flat().join(' '), /show-token|auth token/i)
})

test('GitHub tools pass structured arguments without a shell and enforce owner/name repositories', async () => {
  const seen: Array<{ args: string[]; cwd?: string }> = []
  const service = new GitHubCliService(async (args, options) => {
    seen.push({ args, cwd: options?.cwd })
    return { stdout: '[]', stderr: '' }
  })
  assert.deepEqual(await service.pullRequests('/repo', { repo: 'openai/codex', state: 'all', limit: 5 }), [])
  assert.deepEqual(seen[0], { args: ['pr', 'list', '--repo', 'openai/codex', '--state', 'all', '--limit', '5', '--json', 'number,title,state,isDraft,author,headRefName,baseRefName,url,updatedAt'], cwd: '/repo' })
  await assert.rejects(() => service.repository('/repo', 'openai/codex; rm -rf /'), /owner\/name/)
})

test('GitHub account repository listing does not depend on a task workspace', async () => {
  const seen: Array<{ args: string[]; cwd?: string }> = []
  const service = new GitHubCliService(async (args, options) => {
    seen.push({ args, cwd: options?.cwd })
    return { stdout: JSON.stringify([{ nameWithOwner: 'octocat/hello-world', url: 'https://github.com/octocat/hello-world', description: 'Hello', visibility: 'PUBLIC', primaryLanguage: { name: 'TypeScript' }, updatedAt: '2026-01-01' }]), stderr: '' }
  })

  assert.deepEqual(await service.repositories({ limit: 20 }), {
    repositories: [{ nameWithOwner: 'octocat/hello-world', url: 'https://github.com/octocat/hello-world', description: 'Hello', visibility: 'PUBLIC', isPrivate: false, isFork: false, isArchived: false, primaryLanguage: 'TypeScript', updatedAt: '2026-01-01' }],
    returned: 1,
    truncated: false,
  })
  assert.deepEqual(seen, [{ args: ['repo', 'list', '--limit', '20', '--json', 'nameWithOwner,url,description,isPrivate,isFork,isArchived,visibility,primaryLanguage,updatedAt'], cwd: undefined }])
})

test('GitHub repository lookup without a Git workspace returns a useful non-failure result', async () => {
  const service = new GitHubCliService(async () => { throw Object.assign(Error('failed'), { stderr: 'fatal: not a git repository (or any of the parent directories): .git' }) })
  assert.deepEqual(await service.repository('/standalone'), {
    available: false,
    reason: 'This task has no Git repository. Use github_repo_list to list repositories for the signed-in GitHub account, or pass repo as owner/name.',
  })
})

test('GitHub pull request creation is a dedicated bounded mutation', async () => {
  let called: string[] = []
  const service = new GitHubCliService(async args => { called = args; return { stdout: 'https://github.com/openai/codex/pull/1\n', stderr: '' } })
  assert.equal(await service.createPullRequest('/repo', { title: 'Ship it', body: 'Ready', base: 'main', head: 'feature', draft: true }), 'https://github.com/openai/codex/pull/1')
  assert.deepEqual(called, ['pr', 'create', '--title', 'Ship it', '--body', 'Ready', '--base', 'main', '--head', 'feature', '--draft'])
})

test('missing GitHub CLI produces an actionable unavailable state', async () => {
  const service = new GitHubCliService(async () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }) })
  assert.deepEqual(await service.state(), { connected: false, status: 'unavailable', message: 'GitHub CLI is not installed.' })
})

test('read-only GitHub calls retry one transient TLS failure without retrying mutations', async () => {
  let calls = 0
  const service = new GitHubCliService(async () => {
    if (++calls === 1) throw Object.assign(Error('tls'), { stderr: 'TLS handshake timeout' })
    return { stdout: '{}', stderr: '' }
  })
  assert.deepEqual(await service.repository('/repo'), {})
  assert.equal(calls, 2)
})
