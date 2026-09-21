/**
 * The plugin manifest contract, with no filesystem or Electron dependency of any
 * kind: the application validates packages with this module, and so does the
 * registry when a publisher uploads one. There is exactly one implementation, so
 * the store and the client cannot disagree about what a valid package is.
 */
import type { PluginManifest, PluginPermission, PluginRuntimeAsset, PluginRuntimeExecutable, PluginRuntimeExecutableTarget, PluginViewLaunchSource, PluginViewManifest, PluginWorkspaceRequirement } from './shared.ts'
import { validateShunEngine } from './plugin-engines.ts'
import { isMarketplaceCategory, marketplaceCategories, type MarketplaceEntry } from './marketplace.ts'
import { validPluginFileChangePattern } from './plugin-glob.ts'

export const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
export const viewIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
function normalizeAssetEntry(value: unknown) {
  const entry = String(value || '').replace(/\\/g, '/')
  if (!entry || entry.startsWith('/') || entry.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Plugin view entry must be a package-relative file path.')
  return entry
}

export const pluginPermissionIds = new Set<PluginPermission['id']>(['workspace.git.read', 'workspace.git.write', 'workspace.read', 'workspace.reveal', 'workspace.process', 'workspace.fullscreen', 'conversation.context'])

/**
 * Permission grants travel from a tool call into the host, and that boundary does
 * not preserve an array: a JSON string, a comma-separated list, or a single id all
 * arrive as text. Reading the value as an array silently turns "workspace.read"
 * into fourteen characters, which then fails as an undeclared permission and
 * blocks an install with an error that names the wrong cause.
 */
export function normalizePermissionGrants(value: unknown): PluginPermission['id'][] {
  const listed = (() => {
    if (Array.isArray(value)) return value
    if (typeof value !== 'string') return []
    const text = value.trim()
    if (!text) return []
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        return Array.isArray(parsed) ? parsed : [parsed]
      } catch { return text.replace(/^\[|\]$/g, '').split(',') }
    }
    return text.split(',')
  })()
  return [...new Set(listed.map(item => String(item ?? '').replace(/["'\[\]\s]+/g, ' ').trim()).filter(Boolean))] as PluginPermission['id'][]
}

export function validatePluginPackage(input: unknown, source: PluginManifest['source'] = 'installed'): PluginManifest {
  if (!input || typeof input !== 'object') throw Error('Plugin manifest must be an object.')
  const value = input as Record<string, any>
  if (value.schemaVersion !== 1) throw Error('Unsupported plugin manifest schemaVersion; expected 1.')
  const id = String(value.id || '')
  if (!pluginIdPattern.test(id) || id.length > 80) throw Error('Plugin id must be lowercase dot or hyphen notation.')
  const name = requiredText(value.name, 'name', 100)
  const description = requiredText(value.description, 'description', 500)
  const version = requiredText(value.version, 'version', 50)
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw Error('Plugin version must use semantic versioning.')
  const publisher = requiredText(value.publisher, 'publisher', 100)
  const iconValue = String(value.icon || 'plugin')
  const icon = iconValue === 'git' ? 'git' : 'plugin'
  const iconAsset = iconValue === 'git' || iconValue === 'plugin' ? undefined : normalizeAssetEntry(iconValue)
  if (iconAsset && !/\.svg$/i.test(iconAsset)) throw Error('Custom plugin icon must be a package-relative SVG file.')
  // The distribution tier belongs to the application package. A downloaded
  // package that declares one is rejected outright rather than ignored, so a
  // marketplace package can never present itself as first-party.
  if (value.distribution !== undefined && source !== 'builtin') throw Error('Only built-in plugin packages may declare a distribution tier.')
  const distribution = source !== 'builtin'
    ? undefined
    : value.distribution === undefined || value.distribution === 'required'
      ? 'required' as const
      : value.distribution === 'optional'
        ? 'optional' as const
        : (() => { throw Error(`Unsupported plugin distribution: ${value.distribution}.`) })()
  const engine = value.engines === undefined ? undefined : (() => {
    if (!value.engines || typeof value.engines !== 'object' || Array.isArray(value.engines)) throw Error('engines must be an object.')
    const shun = validateShunEngine(value.engines.shun)
    return shun ? { shun } : undefined
  })()
  const license = value.license === undefined ? undefined : (() => {
    const text = requiredText(value.license, 'license', 40)
    if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(text)) throw Error('license must be an SPDX identifier such as MIT or Apache-2.0.')
    return text
  })()
  const homepage = optionalHttpsUrl(value.homepage, 'homepage')
  const repository = optionalHttpsUrl(value.repository, 'repository')
  const keywords = optionalKeywords(value.keywords)
  const categories = optionalCategories(value.categories)
  const screenshots = optionalScreenshots(value.screenshots)
  const permissions = Array.isArray(value.permissions) ? value.permissions.map((item: any) => {
    const permission = String(item?.id || '') as PluginPermission['id']
    if (!pluginPermissionIds.has(permission)) throw Error(`Unsupported plugin permission: ${permission || '(missing)'}.`)
    return { id: permission, reason: requiredText(item.reason, `permission ${permission} reason`, 300) }
  }) : []
  if (new Set(permissions.map(item => item.id)).size !== permissions.length) throw Error('Plugin permissions must be unique.')
  const views = Array.isArray(value.contributes?.views) ? value.contributes.views.map((item: any) => {
    const viewId = String(item?.id || '')
    if (!viewIdPattern.test(viewId)) throw Error('Plugin view id is invalid.')
    const location = item.location === 'workspace.right' || item.location === 'workspace.main'
      ? 'workspace.right' as const
      : item.location === 'workspace.bottom' && source === 'builtin'
        ? 'workspace.bottom' as const
        : item.location === 'workspace.full' && permissions.some(permission => permission.id === 'workspace.fullscreen')
          ? 'workspace.full' as const
          : null
    if (!location) throw Error(item.location === 'workspace.full'
      ? 'A full-surface plugin view requires the workspace.fullscreen permission.'
      : `Unsupported plugin view location: ${item.location || '(missing)'}.`)
    const entry = normalizeAssetEntry(item.entry)
    const rail = item.rail === undefined || item.rail === 'on-demand' ? 'on-demand' as const : item.rail === 'workspace' ? 'workspace' as const : item.rail === 'transient' ? 'transient' as const : null
    if (!rail) throw Error(`Unsupported plugin view rail policy: ${item.rail}.`)
    if (rail === 'workspace' && source !== 'builtin') throw Error('Only built-in workspace utilities may be present in the activity rail by default; installed plugin views must be on-demand.')
    const allowedLaunchSources = new Set<PluginViewLaunchSource>(['user', 'assistant', 'tool-result'])
    const launch: PluginViewLaunchSource[] = item.launch === undefined
      ? ['user', 'assistant'] as PluginViewLaunchSource[]
      : Array.isArray(item.launch)
        ? item.launch.map((source: unknown) => String(source) as PluginViewLaunchSource)
        : []
    if (!launch.length || launch.some(source => !allowedLaunchSources.has(source)) || new Set(launch).size !== launch.length) throw Error(`Plugin view ${viewId} launch must contain unique supported sources.`)
    const fileChanges = item.activation?.fileChanges === undefined
      ? []
      : Array.isArray(item.activation.fileChanges)
        ? item.activation.fileChanges.map((pattern: unknown) => String(pattern || '').trim().replace(/\\/g, '/'))
        : []
    if (item.activation !== undefined && (!item.activation || typeof item.activation !== 'object' || Array.isArray(item.activation))) throw Error(`Plugin view ${viewId} activation must be an object.`)
    if (item.activation?.fileChanges !== undefined && (!fileChanges.length || fileChanges.length > 16 || fileChanges.some((pattern: string) => !validPluginFileChangePattern(pattern)) || new Set(fileChanges).size !== fileChanges.length)) throw Error(`Plugin view ${viewId} activation.fileChanges must contain 1 through 16 unique safe workspace-relative glob patterns.`)
    if (item.activation?.localEndpoints !== undefined && item.activation.localEndpoints !== true) throw Error(`Plugin view ${viewId} activation.localEndpoints must be true when provided.`)
    if (fileChanges.length && !launch.includes('tool-result')) throw Error(`Plugin view ${viewId} file-change activation requires tool-result launch.`)
    const localEndpoints = item.activation?.localEndpoints === true
    return { id: viewId, title: requiredText(item.title, `view ${viewId} title`, 100), location, entry, rail, launch, ...(fileChanges.length || localEndpoints ? { activation: { ...(fileChanges.length ? { fileChanges } : {}), ...(localEndpoints ? { localEndpoints: true } : {}) } } : {}) }
  }) : []
  if (new Set(views.map((item: { id: string }) => item.id)).size !== views.length) throw Error('Plugin view ids must be unique.')
  // An already-published manifest may carry an empty list, which contributes nothing; a
  // manifest that declares an action is refused, because the host no longer renders one.
  if (value.contributes?.conversationActions?.length) throw Error('A plugin cannot put a control inside the conversation: contribute a view instead, and let the person open it.')
  const skills = Array.isArray(value.contributes?.skills) ? value.contributes.skills.map((item: any) => ({ path: normalizeAssetEntry(item?.path) })) : []
  const workers = Array.isArray(value.contributes?.workers) ? value.contributes.workers.map((item: any) => {
    const workerId = String(item?.id || '')
    if (!viewIdPattern.test(workerId)) throw Error('Plugin worker id is invalid.')
    const timeoutMs = item.timeoutMs === undefined ? 30_000 : Number(item.timeoutMs)
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw Error(`Plugin worker ${workerId} timeoutMs must be an integer from 100 through 120000.`)
    const entry = normalizeAssetEntry(item.entry)
    if (!/\.(?:mjs|js|cjs)$/i.test(entry)) throw Error(`Plugin worker ${workerId} entry must be a JavaScript module.`)
    const runtime = item.runtime === undefined ? [] : Array.isArray(item.runtime) ? item.runtime.map((id: unknown) => String(id || '')) : []
    if (runtime.some((id: string) => !viewIdPattern.test(id)) || new Set(runtime).size !== runtime.length) throw Error(`Plugin worker ${workerId} runtime must contain unique executable ids.`)
    return { id: workerId, entry, timeoutMs, ...(runtime.length ? { runtime } : {}) }
  }) : []
  if (new Set(workers.map((item: { id: string }) => item.id)).size !== workers.length) throw Error('Plugin worker ids must be unique.')
  if (workers.length && !permissions.some(item => item.id === 'workspace.process')) throw Error('Plugin worker contributions require the workspace.process permission.')
  const workspaceValue = value.runtime?.workspace
  const requestsWorkspace = permissions.some(permission => permission.id.startsWith('workspace.'))
  const workspace = (workspaceValue === undefined ? (views.length || workers.length || requestsWorkspace ? 'required' : 'none') : workspaceValue) as PluginWorkspaceRequirement
  if (!['none', 'optional', 'required'].includes(workspace)) throw Error(`Unsupported plugin workspace requirement: ${workspaceValue}.`)
  if (workspace === 'none' && permissions.some(permission => permission.id.startsWith('workspace.'))) throw Error('A workspace-independent plugin cannot request workspace permissions.')
  const runtimeAssets: PluginRuntimeAsset[] = Array.isArray(value.runtime?.assets) ? value.runtime.assets.map((item: any) => {
    const assetId = String(item?.id || '')
    if (!viewIdPattern.test(assetId)) throw Error('Plugin runtime asset id is invalid.')
    const path = normalizeAssetEntry(item.path)
    const sha256 = typeof item.sha256 === 'string' && item.sha256 ? item.sha256 : undefined
    const bytes = Number(item.bytes)
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > 256 * 1024 * 1024) throw Error(`Plugin runtime asset ${assetId} bytes must be an integer from 1 through 268435456.`)
    let url: string | undefined
    if (item.url !== undefined) {
      const parsed = new URL(String(item.url))
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw Error(`Plugin runtime asset ${assetId} URL must be credential-free HTTPS without a fragment.`)
      url = parsed.href
    }
    return { id: assetId, path, bytes, ...(url ? { url } : {}), ...(sha256 ? { sha256 } : {}) }
  }) : []
  if (new Set(runtimeAssets.map(item => item.id)).size !== runtimeAssets.length || new Set(runtimeAssets.map(item => item.path)).size !== runtimeAssets.length) throw Error('Plugin runtime asset ids and paths must be unique.')
  const runtimeExecutables: PluginRuntimeExecutable[] = Array.isArray(value.runtime?.executables) ? value.runtime.executables.map((item: any) => {
    const executableId = String(item?.id || '')
    if (!viewIdPattern.test(executableId)) throw Error('Plugin runtime executable id is invalid.')
    const executableVersion = requiredText(item.version, `runtime executable ${executableId} version`, 80)
    const targets: PluginRuntimeExecutableTarget[] = Array.isArray(item.targets) ? item.targets.map((target: any) => {
      const platform = String(target?.platform || '') as PluginRuntimeExecutableTarget['platform']
      const arch = String(target?.arch || '') as PluginRuntimeExecutableTarget['arch']
      const archive = String(target?.archive || '') as PluginRuntimeExecutableTarget['archive']
      if (!['darwin', 'win32', 'linux'].includes(platform)) throw Error(`Plugin runtime executable ${executableId} target platform is unsupported.`)
      if (!['arm64', 'x64'].includes(arch)) throw Error(`Plugin runtime executable ${executableId} target architecture is unsupported.`)
      if (!['raw', 'tar.gz', 'zip'].includes(archive)) throw Error(`Plugin runtime executable ${executableId} target archive is unsupported.`)
      const entry = normalizeAssetEntry(target.entry)
      const bytes = Number(target.bytes)
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > 256 * 1024 * 1024) throw Error(`Plugin runtime executable ${executableId} target bytes must be an integer from 1 through 268435456.`)
      const parsed = new URL(String(target.url || ''))
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw Error(`Plugin runtime executable ${executableId} target URL must be credential-free HTTPS without a fragment.`)
      const sha256 = typeof target.sha256 === 'string' && target.sha256 ? target.sha256 : undefined
      return { platform, arch, archive, entry, bytes, url: parsed.href, ...(sha256 ? { sha256 } : {}) }
    }) : []
    if (!targets.length || targets.length > 12) throw Error(`Plugin runtime executable ${executableId} requires 1 through 12 platform targets.`)
    const targetKeys = targets.map(target => `${target.platform}-${target.arch}`)
    if (new Set(targetKeys).size !== targetKeys.length) throw Error(`Plugin runtime executable ${executableId} targets must be unique by platform and architecture.`)
    return { id: executableId, version: executableVersion, targets }
  }) : []
  if (new Set(runtimeExecutables.map(item => item.id)).size !== runtimeExecutables.length) throw Error('Plugin runtime executable ids must be unique.')
  const runtimeExecutableIds = new Set(runtimeExecutables.map(item => item.id))
  for (const worker of workers) for (const executableId of worker.runtime || []) if (!runtimeExecutableIds.has(executableId)) throw Error(`Plugin worker ${worker.id} references unknown runtime executable ${executableId}.`)
  const runtimeCacheBytes = runtimeAssets.reduce((total, item) => total + item.bytes, 0)
    + runtimeExecutables.reduce((total, item) => total + Math.max(...item.targets.map(target => target.bytes)), 0)
  if (runtimeCacheBytes > 512 * 1024 * 1024) throw Error('Plugin runtime dependencies exceed the 512 MB current-platform cache budget.')
  const onboarding = validateOnboarding(value.onboarding)
  return {
    id, name, description, version, publisher, icon, ...(iconAsset ? { iconAsset } : {}), source,
    ...(distribution ? { distribution } : {}),
    ...(engine ? { engines: engine } : {}),
    ...(license ? { license } : {}),
    ...(homepage ? { homepage } : {}),
    ...(repository ? { repository } : {}),
    ...(keywords ? { keywords } : {}),
    ...(categories ? { categories } : {}),
    ...(screenshots ? { screenshots } : {}),
    connector: { kind: id === 'git-workbench' ? 'git-cli' : 'package', auth: 'local', setupLabel: id === 'git-workbench' ? 'Uses the Git CLI in the selected workspace' : 'Installed application plugin' },
    bundledSkills: [],
    permissions,
    runtime: { workspace, ...(runtimeAssets.length ? { assets: runtimeAssets } : {}), ...(runtimeExecutables.length ? { executables: runtimeExecutables } : {}) },
    contributes: { views, skills, workers },
    ...(onboarding ? { onboarding } : {}),
    ...(value.experimental === true ? { experimental: true } : {}),
  }
}


function requiredText(value: unknown, label: string, maximum: number) {
  const text = String(value || '').trim()
  if (!text || text.length > maximum) throw Error(`Plugin ${label} is missing or too long.`)
  return text
}


/** Store-facing links must be credential-free HTTPS; anything else is rejected. */function optionalHttpsUrl(value: unknown, label: string) {
  if (value === undefined || value === null || value === '') return undefined
  const text = String(value).trim()
  if (text.length > 300) throw Error(`Plugin ${label} must be at most 300 characters.`)
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw Error(`Plugin ${label} must be an absolute HTTPS URL.`)
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw Error(`Plugin ${label} must be credential-free HTTPS without a fragment.`)
  return parsed.href
}


/**
 * Store categories are chosen from the store's vocabulary rather than invented:
 * a browsable catalog needs a type that means the same thing on every entry.
 */
function optionalCategories(value: unknown): MarketplaceEntry['categories'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw Error('Plugin categories must be an array.')
  if (value.length > 2) throw Error('Plugin categories must contain at most 2 entries.')
  const categories = value.map(item => String(item ?? '').trim())
  for (const category of categories) if (!isMarketplaceCategory(category)) throw Error(`Unsupported plugin category: ${category || '(missing)'}. Choose one of: ${marketplaceCategories.join(', ')}.`)
  if (new Set(categories).size !== categories.length) throw Error('Plugin categories must be unique.')
  return categories as MarketplaceEntry['categories']
}

/**
 * Cover images ship inside the package, exactly like the icon, so the store serves
 * bytes the publisher signed instead of a link to somewhere else.
 */
function optionalScreenshots(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw Error('Plugin screenshots must be an array.')
  if (value.length > 6) throw Error('Plugin screenshots must contain at most 6 entries.')
  const paths = value.map(item => String(item ?? '').replace(/\\/g, '/'))
  if (paths.some(path => !path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..'))) throw Error('Plugin screenshots must be package-relative file paths.')
  if (paths.some(path => !/\.(?:png|jpe?g|webp)$/i.test(path))) throw Error('Plugin screenshots must be PNG, JPEG, or WebP images.')
  if (new Set(paths).size !== paths.length) throw Error('Plugin screenshots must be unique.')
  return paths
}

/** Short display labels for the store. The store's category taxonomy is registry-owned. */function optionalKeywords(value: unknown) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw Error('Plugin keywords must be an array.')
  if (value.length > 8) throw Error('Plugin keywords must contain at most 8 entries.')
  const keywords = value.map(item => String(item ?? '').trim())
  if (keywords.some(keyword => !/^[A-Za-z0-9][A-Za-z0-9 .+#-]{0,31}$/.test(keyword))) throw Error('Plugin keywords must be 1-32 characters of letters, digits, spaces, or . + # -')
  if (new Set(keywords.map(keyword => keyword.toLowerCase())).size !== keywords.length) throw Error('Plugin keywords must be unique.')
  return keywords.length ? keywords : undefined
}

function validateOnboarding(input: unknown): PluginManifest['onboarding'] {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || !Array.isArray((input as any).steps)) throw Error('Plugin onboarding must contain a steps array.')
  const value = input as any
  const seen = new Set<string>()
  const steps = value.steps.map((item: any) => {
    const id = requiredText(item?.id, 'onboarding step id', 80)
    if (!viewIdPattern.test(id) || seen.has(id)) throw Error(`Invalid or duplicate onboarding step id: ${id}.`)
    seen.add(id)
    const type = String(item.type || '')
    const common = { id, type, title: requiredText(item.title, `onboarding step ${id} title`, 100), description: requiredText(item.description, `onboarding step ${id} description`, 500) }
    if (type === 'info' || type === 'permissions') return common
    if (type === 'secret') return { ...common, key: requiredText(item.key, `onboarding step ${id} key`, 80), label: requiredText(item.label, `onboarding step ${id} label`, 100) }
    if (type === 'oauth') return { ...common, connection: requiredText(item.connection, `onboarding step ${id} connection`, 80) }
    if (type === 'choice') {
      const options = Array.isArray(item.options) ? item.options.map((option: any) => ({ label: requiredText(option?.label, `onboarding step ${id} option label`, 100), value: requiredText(option?.value, `onboarding step ${id} option value`, 100) })) : []
      if (options.length < 2 || options.length > 20) throw Error(`Choice onboarding step ${id} requires 2-20 options.`)
      return { ...common, key: requiredText(item.key, `onboarding step ${id} key`, 80), options }
    }
    throw Error(`Unsupported onboarding step type: ${type || '(missing)'}.`)
  })
  return { reopenable: value.reopenable !== false, steps }
}
