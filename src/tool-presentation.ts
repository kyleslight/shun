import type { ToolEvent } from './shared.ts'

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
  kind: 'github' | 'figma' | 'gmail' | 'render' | 'cloudflare' | 'browser' | 'ios' | 'godot' | 'skill' | 'schedule'
}

export function productToolPresentation(tool: Pick<ToolEvent, 'name' | 'input' | 'output' | 'state'>): ProductToolPresentation | undefined {
  const input = structuredInput(tool.input), failed = tool.state === 'error'
  const skill = tool.name === 'read' ? skillInstructionName(input.path) : ''
  if (skill) return skillPresentation(failed ? 'Skill instructions read failed' : 'Read Skill instructions', `${skill} · instructions`)
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
    case 'gmail_label_list': return gmailPresentation(failed ? 'Gmail label listing failed' : 'Listed Gmail labels', 'mailbox labels')
    case 'gmail_message_list': return gmailPresentation(failed ? 'Gmail search failed' : 'Searched Gmail messages', input.query || 'recent mail')
    case 'gmail_message_read': return gmailPresentation(failed ? 'Gmail message read failed' : 'Read Gmail message', input.message_id)
    case 'gmail_thread_read': return gmailPresentation(failed ? 'Gmail thread read failed' : 'Read Gmail thread', input.thread_id)
    case 'gmail_attachment_import': return gmailPresentation(failed ? 'Gmail attachment import failed' : 'Imported Gmail attachment', input.filename)
    case 'gmail_message_modify': return gmailPresentation(failed ? 'Gmail message update failed' : gmailActionTitle(input.action), input.message_id)
    case 'gmail_draft_create': return gmailPresentation(failed ? 'Gmail draft creation failed' : 'Created Gmail draft', input.subject)
    case 'gmail_message_send': return gmailPresentation(failed ? 'Gmail send failed' : 'Sent Gmail message', gmailRecipients(input.to))
    case 'gmail_draft_send': return gmailPresentation(failed ? 'Gmail draft send failed' : 'Sent Gmail draft', input.draft_id)
    case 'render_service_list': return renderPresentation(failed ? 'Render service listing failed' : 'Listed Render services', input.name || input.owner_id || 'connected workspaces')
    case 'render_service_read': return renderPresentation(failed ? 'Render service read failed' : 'Read Render service', input.service_id)
    case 'render_deploy_list': return renderPresentation(failed ? 'Render deploy listing failed' : 'Listed Render deploys', input.service_id)
    case 'render_logs': return renderPresentation(failed ? 'Render log read failed' : 'Read Render logs', input.resource_id)
    case 'render_deploy_trigger': return renderPresentation(failed ? 'Render deployment failed' : 'Triggered Render deployment', input.service_id)
    case 'cloudflare_account_list': return cloudflarePresentation(failed ? 'Cloudflare account listing failed' : 'Listed Cloudflare accounts', input.name || cloudflareAccountName(tool.output) || 'Cloudflare accounts')
    case 'cloudflare_zone_list': return cloudflarePresentation(failed ? 'Cloudflare zone listing failed' : 'Listed Cloudflare zones', input.name || cloudflareAccountName(tool.output) || 'Cloudflare zones')
    case 'cloudflare_dns_record_list': return cloudflarePresentation(failed ? 'Cloudflare DNS read failed' : 'Listed Cloudflare DNS records', input.name || 'DNS records')
    case 'cloudflare_worker_list': return cloudflarePresentation(failed ? 'Cloudflare Worker listing failed' : 'Listed Cloudflare Workers', 'Cloudflare Workers')
    case 'cloudflare_worker_deployment_list': return cloudflarePresentation(failed ? 'Worker deployment listing failed' : 'Listed Worker deployments', input.script_name)
    case 'cloudflare_pages_project_list': return cloudflarePresentation(failed ? 'Pages project listing failed' : 'Listed Pages projects', 'Cloudflare Pages')
    case 'cloudflare_pages_deployment_list': return cloudflarePresentation(failed ? 'Pages deployment listing failed' : 'Listed Pages deployments', input.project_name)
    case 'cloudflare_pages_deployment_logs': return cloudflarePresentation(failed ? 'Pages deployment log read failed' : 'Read Pages deployment logs', input.project_name)
    case 'cloudflare_pages_deployment_retry': return cloudflarePresentation(failed ? 'Pages deployment retry failed' : 'Retried Pages deployment', input.project_name)
    case 'cloudflare_cache_purge': return cloudflarePresentation(failed ? 'Cloudflare cache purge failed' : 'Purged Cloudflare cache', input.purge_everything ? 'entire zone cache' : cacheTargets(input.files))
    case 'browser_debug': return {
      title: failed ? 'Local page inspection failed' : 'Inspected local page',
      detail: compactUrl(input.url || 'localhost'),
      kind: 'browser',
    }
    case 'browser_tabs': return browserPresentation(failed ? 'Chrome tab listing failed' : 'Listed Chrome tabs', 'existing Chrome')
    case 'browser_claim': return browserPresentation(failed ? 'Chrome tab claim failed' : 'Claimed Chrome tab', browserPageTarget(tool.output, 'Selected Chrome tab'))
    case 'browser_open': return browserPresentation(failed ? 'Chrome tab open failed' : 'Opened Chrome tab', browserPageTarget(tool.output, compactUrl(input.url || 'Chrome')))
    case 'browser_snapshot': return browserPresentation(failed ? 'Chrome inspection failed' : 'Inspected Chrome tab', browserPageTarget(tool.output, 'Current Chrome tab'))
    case 'browser_navigate': return browserPresentation(failed ? 'Chrome navigation failed' : 'Navigated Chrome tab', browserPageTarget(tool.output, compactUrl(input.url || 'Chrome')))
    case 'browser_act': return browserPresentation(failed ? 'Chrome interaction failed' : 'Interacted with Chrome tab', browserPageTarget(tool.output, 'Current Chrome tab'))
    case 'browser_download': return browserPresentation(failed ? 'Chrome download failed' : 'Downloaded from Chrome', downloadedFile(tool.output) || 'Current Chrome tab')
    case 'browser_download_wait': return browserPresentation(failed ? 'Chrome download wait failed' : 'Waited for Chrome download', downloadedFile(tool.output) || 'Current Chrome tab')
    case 'browser_release': return browserPresentation(failed ? 'Chrome release failed' : 'Released Chrome tab', browserPageTarget(tool.output, 'Current Chrome tab'))
    case 'ios_simulator_devices': return iosPresentation(failed ? 'iOS Simulator device listing failed' : 'Listed iOS Simulator devices', 'local Xcode runtimes')
    case 'ios_simulator_device': return iosPresentation(failed ? 'iOS Simulator device operation failed' : input.action === 'shutdown' ? 'Shut down iOS Simulator' : 'Booted iOS Simulator', input.device)
    case 'ios_simulator_app': return iosPresentation(failed ? 'iOS Simulator app operation failed' : iosAppTitle(input.action), input.bundle_id || input.app_path || input.url || input.device)
    case 'ios_simulator_setting': return iosPresentation(failed ? 'iOS Simulator setting failed' : 'Changed iOS Simulator state', [input.action, input.value].filter(Boolean).join(' · ') || input.device)
    case 'ios_simulator_snapshot': return iosPresentation(failed ? 'iOS Simulator inspection failed' : 'Inspected iOS Simulator', input.device)
    case 'ios_simulator_act': return iosPresentation(failed ? 'iOS Simulator interaction failed' : 'Interacted with iOS Simulator', [input.action, input.device].filter(Boolean).join(' · '))
    case 'godot_project_inspect': return godotPresentation(failed ? 'Godot project inspection failed' : 'Inspected Godot project', input.project_path || 'task workspace')
    case 'godot_script_check': return godotPresentation(failed ? 'Godot script check failed' : 'Checked Godot script', input.script_path)
    case 'godot_project_import': return godotPresentation(failed ? 'Godot project import failed' : 'Refreshed Godot imports', input.project_path || 'task workspace')
    case 'skill_catalog_search': return skillPresentation(failed ? 'Skill catalog search failed' : 'Searched installable Skills', input.query || 'public Skill sources')
    case 'skill_create': return skillPresentation(failed ? 'Skill creation failed' : 'Created Skill', input.name)
    case 'skill_update': return skillPresentation(failed ? 'Skill update failed' : 'Updated Skill', input.name)
    case 'skill_install': return skillPresentation(
      failed ? 'Skill installation failed' : tool.output?.includes('"selection_required"') ? 'Reviewed Skill source' : 'Installed Skill',
      input.source,
    )
    case 'skill_remove': return skillPresentation(failed ? 'Skill removal failed' : 'Removed Skills', Array.isArray(input.names) ? input.names.join(', ') : 'user-installed Skills')
    case 'installed_skill_list': return skillPresentation(failed ? 'Installed Skill listing failed' : 'Listed installed Skills', 'Shun Skills')
    case 'installed_skill_read': return skillPresentation(failed ? 'Installed Skill read failed' : 'Read installed Skill', input.skill_id)
    case 'skill_run': {
      const operation = input.command || (Array.isArray(input.args) ? input.args[0] : '')
      return skillPresentation(failed ? 'Skill script failed' : 'Ran Skill script', [input.skill, operation || input.script].filter(Boolean).join(' · '))
    }
    case 'plugin_tool_search': return { title: failed ? 'Plugin tool discovery failed' : 'Prepared plugin tools', detail: '', kind: 'skill' }
    case 'schedule_create': return schedulePresentation(failed ? 'Scheduled task creation failed' : 'Created scheduled task', input.name || scheduleTriggerDetail(input))
    case 'schedule_list': return schedulePresentation(failed ? 'Scheduled task listing failed' : 'Listed scheduled tasks', 'this task')
    case 'schedule_update': return schedulePresentation(failed ? 'Scheduled task update failed' : 'Updated scheduled task', input.name || input.status || 'this task')
    case 'schedule_delete': return schedulePresentation(failed ? 'Scheduled task deletion failed' : 'Deleted scheduled task', 'this task')
    default: return undefined
  }
}

export function productToolOutputForDisplay(tool: Pick<ToolEvent, 'name' | 'input' | 'state' | 'output'>) {
  const output = String(tool.output || '')
  if (productToolPresentation(tool)?.kind === 'browser') return browserOutputForDisplay(output)
  if (tool.name !== 'read') return output
  const presentation = productToolPresentation(tool)
  if (presentation?.kind !== 'skill') return output
  const path = String(structuredInput(tool.input).path || '')
  if (!path) return output
  const replacement = presentation.detail
  return output
    .split(path).join(replacement)
    .split(path.replace(/\\/g, '/')).join(replacement)
}

const browserInternalFields = new Set([
  'id', 'session_id', 'tab_id', 'taskId', 'createdByRunId', 'tabId', 'windowId', 'owned',
  'createdAt', 'updatedAt', 'lastSnapshotAt', 'lastScreenshotAt',
])

function browserOutputForDisplay(output: string) {
  if (!output.trim()) return output
  try { return JSON.stringify(stripBrowserInternalFields(JSON.parse(output)), null, 2) } catch { return output }
}

function stripBrowserInternalFields(value: any): any {
  if (Array.isArray(value)) return value.map(stripBrowserInternalFields)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !browserInternalFields.has(key))
    .map(([key, child]) => [key, stripBrowserInternalFields(child)]))
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

function gmailPresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'Gmail').slice(0, 160), kind: 'gmail' }
}

function gmailActionTitle(action: unknown) {
  const titles: Record<string, string> = {
    mark_read: 'Marked Gmail message read', mark_unread: 'Marked Gmail message unread', archive: 'Archived Gmail message',
    star: 'Starred Gmail message', unstar: 'Unstarred Gmail message', trash: 'Moved Gmail message to trash', untrash: 'Restored Gmail message from trash',
  }
  return titles[String(action || '')] || 'Updated Gmail message'
}

function gmailRecipients(value: unknown) {
  return Array.isArray(value) ? value.map(String).slice(0, 3).join(', ') : 'Gmail recipients'
}

function renderPresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'Render').slice(0, 160), kind: 'render' }
}

function browserPresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'Chrome').slice(0, 100), kind: 'browser' }
}

function iosPresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'iOS Simulator').slice(0, 160), kind: 'ios' }
}

function godotPresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'Godot project').slice(0, 160), kind: 'godot' }
}

function iosAppTitle(action: unknown) {
  const titles: Record<string, string> = {
    install: 'Installed iOS app', uninstall: 'Uninstalled iOS app', launch: 'Launched iOS app',
    terminate: 'Terminated iOS app', open_url: 'Opened URL in iOS Simulator',
  }
  return titles[String(action || '')] || 'Controlled iOS app'
}

function browserPageTarget(output: unknown, fallback: string) {
  const value = structuredInput(String(output || ''))
  const title = String(value.title || '').replace(/\s+/g, ' ').trim()
  const host = urlHost(value.url)
  if (title && host && !title.toLowerCase().includes(host.toLowerCase())) return `${title} · ${host}`
  return title || host || fallback
}

function downloadedFile(output: unknown) {
  const value = structuredInput(String(output || ''))
  const path = String(value.filename || value.fileName || value.path || '').trim()
  return path.split(/[\\/]/).pop() || ''
}

function urlHost(value: unknown) {
  try { return new URL(String(value || '')).hostname.replace(/^www\./, '') } catch { return '' }
}

function skillPresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'Skill').slice(0, 160), kind: 'skill' }
}

function schedulePresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'Scheduled task').slice(0, 160), kind: 'schedule' }
}

function scheduleTriggerDetail(input: Record<string, any>) {
  if (input.at) return String(input.at)
  return [input.cron, input.timezone].filter(Boolean).join(' · ')
}

function cloudflarePresentation(title: string, target: unknown): ProductToolPresentation {
  return { title, detail: String(target || 'Cloudflare').slice(0, 160), kind: 'cloudflare' }
}

function cloudflareAccountName(output: unknown) {
  const value = structuredInput(String(output || ''))
  const rows = Array.isArray(value.result) ? value.result : Array.isArray(value) ? value : []
  const first = rows[0]
  return String(first?.account?.name || first?.name || '').replace(/\s+/g, ' ').trim().slice(0, 100)
}

function cacheTargets(files: unknown) {
  const urls = Array.isArray(files) ? files : []
  const hosts = [...new Set(urls.map(urlHost).filter(Boolean))]
  const count = urls.length
  return [hosts.slice(0, 2).join(', '), `${count} URL${count === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
}

function skillInstructionName(value: unknown) {
  const path = String(value || '').replace(/\\/g, '/')
  return path.match(/(?:^|\/)\.shun\/skills\/([^/]+)\/SKILL\.md$/i)?.[1]
    || path.match(/(?:^|\/)\.shun\/resources\/plugin-skills\/[^/]+\/([^/]+)\/SKILL\.md$/i)?.[1]
    || ''
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
