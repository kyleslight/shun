import type { ToolEvent } from '../../shared.ts'

export function isShellTool(tool: Pick<ToolEvent, 'name'> | string) {
  const name = typeof tool === 'string' ? tool : tool.name
  return name === 'bash' || name === 'run'
}

export function shellCommand(tool: Pick<ToolEvent, 'name' | 'input'>) {
  if (!isShellTool(tool)) return ''
  try {
    const command = JSON.parse(tool.input || '{}').command
    return typeof command === 'string' ? command.trim() : ''
  } catch {
    return ''
  }
}

export type ProductToolPresentation = {
  title: string
  detail: string
  kind: 'github' | 'figma' | 'browser'
}

export function productToolPresentation(tool: Pick<ToolEvent, 'name' | 'input' | 'state'>): ProductToolPresentation | undefined {
  const input = structuredInput(tool.input), failed = tool.state === 'error'
  switch (tool.name) {
    case 'github_repo_list': return {
      title: failed ? 'GitHub repository listing failed' : 'Listed GitHub repositories',
      detail: input.owner ? `${input.owner} repositories` : 'my repositories',
      kind: 'github',
    }
    case 'github_repository': return {
      title: failed ? 'GitHub repository lookup failed' : 'Read GitHub repository',
      detail: input.repo || 'current workspace repository',
      kind: 'github',
    }
    case 'github_pr_list': return githubPresentation(failed ? 'GitHub pull request listing failed' : 'Listed GitHub pull requests', input.repo)
    case 'github_pr_read': return githubPresentation(failed ? 'GitHub pull request read failed' : 'Read GitHub pull request', numberedTarget(input.repo, input.number))
    case 'github_pr_create': return githubPresentation(failed ? 'GitHub pull request creation failed' : 'Created GitHub pull request', input.repo || input.title)
    case 'github_issue_list': return githubPresentation(failed ? 'GitHub issue listing failed' : 'Listed GitHub issues', input.repo)
    case 'github_run_list': return githubPresentation(failed ? 'GitHub Actions read failed' : 'Listed GitHub Actions runs', input.repo || input.branch)
    case 'figma_read_design': return figmaPresentation(failed ? 'Figma design read failed' : 'Read Figma design', input.url)
    case 'figma_render_node': return figmaPresentation(failed ? 'Figma node render failed' : 'Rendered Figma node', input.url)
    case 'figma_list_assets': return figmaPresentation(failed ? 'Figma asset listing failed' : 'Listed Figma assets', input.url)
    case 'figma_read_variables': return figmaPresentation(failed ? 'Figma variable read failed' : 'Read Figma variables', input.url)
    case 'browser_debug': return {
      title: failed ? 'Local page inspection failed' : 'Inspected local page',
      detail: compactUrl(input.url || 'localhost'),
      kind: 'browser',
    }
    default: return undefined
  }
}

function structuredInput(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function githubPresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'current workspace repository'), kind: 'github' }
}

function figmaPresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: compactUrl(target), kind: 'figma' }
}

function numberedTarget(repo: unknown, number: unknown) {
  const prefix = repo ? `${String(repo)} · ` : ''
  return `${prefix}#${String(number || '?')}`
}

function compactUrl(value: unknown) {
  const raw = String(value || 'Figma link')
  try {
    const url = new URL(raw)
    return `${url.hostname}${url.pathname}`.slice(0, 100)
  } catch {
    return raw.slice(0, 100)
  }
}
