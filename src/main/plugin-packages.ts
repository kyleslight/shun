import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import type { PluginManifest, PluginPermission, PluginRuntimeAsset, PluginRuntimeExecutable, PluginRuntimeExecutableTarget, PluginState, PluginViewContribution, PluginViewDescriptor, PluginViewLaunchSource, PluginViewManifest, PluginWorkspaceRequirement, Settings } from '../shared.ts'
import { validPluginFileChangePattern } from './plugin-view-activation.ts'

type PackageRecord = { manifest: PluginManifest; root: string }
export type PluginRuntimeAssetDescriptor = PluginRuntimeAsset & { cachePath: string; developmentPath?: string }
export type PluginRuntimeExecutableDescriptor = PluginRuntimeExecutableTarget & { id: string; version: string; cachePath: string; developmentPath?: string }

const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const viewIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const permissionIds = new Set<PluginPermission['id']>(['workspace.git.read', 'workspace.git.write', 'workspace.read', 'workspace.reveal', 'workspace.process', 'conversation.context', 'conversation.ui'])

export class PluginPackageRegistry {
  #records = new Map<string, PackageRecord>()
  #sources = new Map<string, string>()
  #viewGrants = new Map<string, { pluginId: string; viewId: string; workspace: string; taskId: string; permissions: Set<string>; expiresAt: number }>()
  private bundledRoot: string
  private installedRoot: string
  private runtimeAssetsRoot: string

  constructor(bundledRoot: string, installedRoot: string, runtimeAssetsRoot = join(installedRoot, '.runtime-assets')) {
    this.bundledRoot = bundledRoot
    this.installedRoot = installedRoot
    this.runtimeAssetsRoot = runtimeAssetsRoot
  }

  async refresh() {
    this.#sources = new Map(Object.entries(await readJson<Record<string, string>>(this.#sourcesFile(), {})).filter((entry): entry is [string, string] => pluginIdPattern.test(entry[0]) && typeof entry[1] === 'string'))
    const records = new Map<string, PackageRecord>()
    for (const [root, source] of [[this.bundledRoot, 'builtin'], [this.installedRoot, 'installed']] as const) {
      for (const directory of await childDirectories(root)) {
        try {
          const manifest = validatePluginPackage(await readPluginManifest(directory), source)
          if (!records.has(manifest.id) || source === 'builtin') records.set(manifest.id, { manifest, root: directory })
        } catch (error) {
          console.warn('[plugin-package]', directory, error instanceof Error ? error.message : error)
        }
      }
    }
    this.#records = records
    return this.manifests()
  }

  manifests() {
    return [...this.#records.values()].map(item => withIconUrl(cloneManifest(item.manifest)))
  }

  manifest(pluginId: string) {
    const record = this.#records.get(pluginId)
    return record ? withIconUrl(cloneManifest(record.manifest)) : undefined
  }

  states(settings: Pick<Settings, 'plugins'>): PluginState[] {
    return this.manifests().map(manifest => {
      const installation = settings.plugins?.find(item => item.id === manifest.id)
      return {
        ...manifest,
        installed: Boolean(installation),
        enabled: Boolean(installation) && installation?.enabled !== false,
        detail: manifest.connector.setupLabel,
        ...(this.#sources.has(manifest.id) ? { reloadable: true, developmentSource: this.#sources.get(manifest.id) } : {}),
      }
    })
  }

  views(settings: Pick<Settings, 'plugins'>): PluginViewDescriptor[] {
    const now = Date.now()
    for (const [token, grant] of this.#viewGrants) if (grant.expiresAt <= now) this.#viewGrants.delete(token)
    return this.manifests().flatMap(manifest => {
      const installation = settings.plugins?.find(item => item.id === manifest.id && item.enabled !== false)
      if (!installation) return []
      const required = manifest.permissions?.map(item => item.id) || []
      const granted = new Set(installation.permissions || (manifest.source === 'builtin' ? required : []))
      if (required.some(permission => !granted.has(permission))) return []
      return (manifest.contributes?.views || []).map(view => ({
          pluginId: manifest.id,
          viewId: view.id,
          title: view.title,
          location: view.location,
          url: `shun-plugin://${manifest.id}/${view.entry}`,
          icon: manifest.icon,
          ...(manifest.iconAsset ? { iconUrl: `shun-plugin://${manifest.id}/${manifest.iconAsset}` } : {}),
          permissions: required,
          workspace: manifest.runtime?.workspace || 'required',
          rail: view.rail || 'on-demand',
          launch: view.launch || ['user', 'assistant'],
          ...(view.activation ? { activation: view.activation } : {}),
          experimental: manifest.experimental,
        }))
    })
  }

  openView(settings: Pick<Settings, 'plugins'>, pluginId: string, viewId: string, workspace: string, taskId: string): PluginViewContribution {
    const view = this.views(settings).find(item => item.pluginId === pluginId && item.viewId === viewId)
    if (!view) throw Error('Plugin view is unavailable or missing required permission grants.')
    if (view.workspace === 'required' && !workspace) throw Error('This plugin view requires a selected workspace.')
    const boundWorkspace = view.workspace === 'none' ? '' : workspace
    const accessToken = randomUUID()
    const instanceUrl = new URL(view.url)
    instanceUrl.searchParams.set('instance', randomUUID())
    const boundTaskId = String(taskId || '')
    this.#viewGrants.set(accessToken, { pluginId, viewId, workspace: boundWorkspace, taskId: boundTaskId, permissions: new Set(view.permissions), expiresAt: Date.now() + 12 * 60 * 60_000 })
    return { ...view, url: instanceUrl.href, accessToken, boundWorkspace, boundTaskId }
  }

  closeView(accessToken: string) {
    return this.#viewGrants.delete(accessToken)
  }

  skillDirectories(settings: Pick<Settings, 'plugins'>) {
    return this.manifests().flatMap(manifest => {
      const installation = settings.plugins?.find(item => item.id === manifest.id && item.enabled !== false)
      const record = this.#records.get(manifest.id)
      if (!installation || !record) return []
      return (manifest.contributes?.skills || []).map(skill => ({ pluginId: manifest.id, path: resolve(record.root, skill.path), icon: manifest.icon }))
    })
  }

  authorizeView(pluginId: string, viewId: string, accessToken: string, permission: PluginPermission['id'], workspace: string, taskId: string) {
    const manifest = this.authenticateView(pluginId, viewId, accessToken, workspace, taskId)
    if (!manifest.permissions?.some(item => item.id === permission)) throw Error(`Plugin is not allowed to use ${permission}.`)
    const grant = this.#viewGrants.get(accessToken)
    if (!grant?.permissions.has(permission)) throw Error('Plugin view authorization is missing or expired.')
    return manifest
  }

  authenticateView(pluginId: string, viewId: string, accessToken: string, workspace: string, taskId: string) {
    const manifest = this.#records.get(pluginId)?.manifest
    if (!manifest?.contributes?.views?.some(view => view.id === viewId)) throw Error('Unknown plugin view.')
    const grant = this.#viewGrants.get(accessToken)
    if (!grant || grant.expiresAt <= Date.now() || grant.pluginId !== pluginId || grant.viewId !== viewId) throw Error('Plugin view authorization is missing or expired.')
    if (grant.workspace !== workspace) throw Error('Plugin view authorization belongs to another workspace.')
    if (grant.taskId !== taskId) throw Error('Plugin view authorization belongs to another task.')
    return manifest
  }

  assetPath(pluginId: string, requestedPath: string) {
    const record = this.#records.get(pluginId)
    if (!record) throw Error('Unknown plugin package.')
    const decoded = decodeURIComponent(requestedPath).replace(/^\/+/, '')
    const target = resolve(record.root, decoded)
    if (target !== record.root && !target.startsWith(`${record.root}${sep}`)) throw Error('Plugin asset path escapes its package.')
    return target
  }

  runtimeAsset(pluginId: string, requestedPath: string): PluginRuntimeAssetDescriptor {
    const record = this.#records.get(pluginId)
    if (!record) throw Error('Unknown plugin package.')
    const decoded = decodeURIComponent(requestedPath).replace(/^\/+/, '')
    if (!decoded.startsWith('__runtime__/')) throw Error('Plugin runtime asset path is invalid.')
    const virtualPath = decoded.slice('__runtime__/'.length)
    const asset = record.manifest.runtime?.assets?.find(item => item.path === virtualPath)
    if (!asset) throw Error('Unknown plugin runtime asset.')
    const developmentSource = this.#sources.get(pluginId)
    return {
      ...asset,
      cachePath: resolve(this.runtimeAssetsRoot, pluginId, record.manifest.version, asset.path),
      ...(developmentSource ? { developmentPath: resolve(`${developmentSource}.runtime-assets`, asset.path) } : {}),
    }
  }

  runtimeExecutable(pluginId: string, executableId: string, platform = process.platform, arch = process.arch): PluginRuntimeExecutableDescriptor {
    const record = this.#records.get(pluginId)
    if (!record) throw Error('Unknown plugin package.')
    const executable = record.manifest.runtime?.executables?.find(item => item.id === executableId)
    if (!executable) throw Error(`Unknown plugin runtime executable: ${executableId || '(missing)'}.`)
    const target = executable.targets.find(item => item.platform === platform && item.arch === arch)
    if (!target) throw Error(`Plugin runtime executable ${executableId} does not support ${platform}-${arch}.`)
    const developmentSource = this.#sources.get(pluginId)
    return {
      ...target,
      id: executable.id,
      version: executable.version,
      cachePath: resolve(this.runtimeAssetsRoot, pluginId, record.manifest.version, 'executables', executable.id, `${platform}-${arch}`, target.entry),
      ...(developmentSource ? { developmentPath: resolve(`${developmentSource}.runtime-assets`, 'executables', executable.id, `${platform}-${arch}`, target.entry) } : {}),
    }
  }

  worker(pluginId: string, workerId: string) {
    const record = this.#records.get(pluginId)
    if (!record) throw Error('Unknown plugin package.')
    const worker = record.manifest.contributes?.workers?.find(item => item.id === workerId)
    if (!worker) throw Error(`Unknown plugin worker: ${workerId || '(missing)'}.`)
    return { entry: resolve(record.root, worker.entry), timeoutMs: worker.timeoutMs, runtime: worker.runtime || [] }
  }

  async installFromDirectory(source: string) {
    const sourceRoot = resolve(source)
    const manifest = validatePluginPackage(await readPluginManifest(sourceRoot), 'installed')
    if (this.#records.get(manifest.id)?.manifest.source === 'builtin') throw Error(`Plugin id ${manifest.id} is reserved by a built-in package.`)
    await validatePackageAssets(sourceRoot, manifest)
    await mkdir(this.installedRoot, { recursive: true })
    const target = join(this.installedRoot, manifest.id)
    const staging = join(this.installedRoot, `.${manifest.id}-${Date.now()}.installing`)
    const previous = join(this.installedRoot, `.${manifest.id}-${Date.now()}.previous`)
    await rm(staging, { recursive: true, force: true })
    await cp(sourceRoot, staging, { recursive: true, force: false, errorOnExist: true })
    const replacing = await stat(target).then(() => true, () => false)
    if (replacing) await rename(target, previous)
    try {
      await rename(staging, target)
    } catch (error) {
      if (replacing) await rename(previous, target).catch(() => {})
      throw error
    }
    if (replacing) await rm(previous, { recursive: true, force: true })
    this.#sources.set(manifest.id, sourceRoot)
    await this.#writeSources()
    await this.refresh()
    return this.manifest(manifest.id)!
  }

  async inspectDirectory(source: string) {
    const sourceRoot = resolve(source)
    const manifest = validatePluginPackage(await readPluginManifest(sourceRoot), 'installed')
    await validatePackageAssets(sourceRoot, manifest)
    return manifest
  }

  async reload(pluginId: string) {
    const source = this.#sources.get(pluginId)
    if (!source) throw Error('This plugin was not installed from a reloadable development folder.')
    const manifest = await this.inspectDirectory(source)
    if (manifest.id !== pluginId) throw Error('The development package id changed; install it as a new plugin instead.')
    return this.installFromDirectory(source)
  }

  async remove(pluginId: string) {
    const record = this.#records.get(pluginId)
    if (!record) return false
    if (record.manifest.source === 'builtin') throw Error('Built-in plugins cannot be removed.')
    const target = resolve(this.installedRoot, pluginId)
    if (record.root !== target) throw Error('Plugin package is not owned by the local plugin registry.')
    await rm(target, { recursive: true, force: true })
    this.#sources.delete(pluginId)
    for (const [token, grant] of this.#viewGrants) if (grant.pluginId === pluginId) this.#viewGrants.delete(token)
    await this.#writeSources()
    await this.refresh()
    return true
  }

  #sourcesFile() { return join(this.installedRoot, '.development-sources.json') }
  async #writeSources() {
    await mkdir(this.installedRoot, { recursive: true })
    await writeFile(this.#sourcesFile(), JSON.stringify(Object.fromEntries(this.#sources), null, 2), { encoding: 'utf8', mode: 0o600 })
  }
}

async function readPluginManifest(root: string) {
  let text = ''
  try {
    text = await readFile(join(root, 'manifest.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error('A Shun plugin package root must contain manifest.json.')
    throw error
  }
  try {
    return JSON.parse(text)
  } catch {
    throw Error('Shun plugin manifest.json must contain valid JSON.')
  }
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
  const permissions = Array.isArray(value.permissions) ? value.permissions.map((item: any) => {
    const permission = String(item?.id || '') as PluginPermission['id']
    if (!permissionIds.has(permission)) throw Error(`Unsupported plugin permission: ${permission || '(missing)'}.`)
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
        : null
    if (!location) throw Error(`Unsupported plugin view location: ${item.location || '(missing)'}.`)
    const entry = normalizeAssetEntry(item.entry)
    const rail = item.rail === undefined || item.rail === 'on-demand' ? 'on-demand' as const : item.rail === 'workspace' ? 'workspace' as const : item.rail === 'transient' ? 'transient' as const : null
    if (!rail) throw Error(`Unsupported plugin view rail policy: ${item.rail}.`)
    if (rail === 'workspace' && source !== 'builtin') throw Error('Only built-in workspace utilities may be present in the activity rail by default; installed plugin views must be on-demand.')
    const allowedLaunchSources = new Set<PluginViewLaunchSource>(['user', 'assistant', 'tool-result', 'conversation-action'])
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
  const conversationActions = Array.isArray(value.contributes?.conversationActions) ? value.contributes.conversationActions.map((item: any) => {
    const actionId = requiredText(item.id, 'conversation action id', 80)
    if (!viewIdPattern.test(actionId)) throw Error('Plugin conversation action id is invalid.')
    const placement = item.placement === 'composer' ? 'composer' as const : item.placement === 'message' ? 'message' as const : null
    if (!placement) throw Error(`Unsupported conversation action placement: ${item.placement || '(missing)'}.`)
    const command = item.command === undefined ? undefined : requiredText(item.command, 'conversation action command', 120)
    const viewId = item.viewId === undefined ? undefined : requiredText(item.viewId, 'conversation action viewId', 80)
    if (!command && !viewId) throw Error(`Plugin conversation action ${actionId} must declare command or viewId.`)
    const view = viewId ? views.find((candidate: PluginViewManifest) => candidate.id === viewId) : undefined
    if (viewId && !view) throw Error(`Plugin conversation action ${actionId} references unknown view ${viewId}.`)
    if (view && !view.launch.includes('conversation-action')) throw Error(`Plugin view ${viewId} must allow conversation-action launch.`)
    return { id: actionId, title: requiredText(item.title, 'conversation action title', 100), placement, ...(command ? { command } : {}), ...(viewId ? { viewId } : {}) }
  }) : []
  if (new Set(conversationActions.map((item: { id: string }) => item.id)).size !== conversationActions.length) throw Error('Plugin conversation action ids must be unique.')
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
  if (conversationActions.length && !permissions.some(item => item.id === 'conversation.ui')) throw Error('Conversation UI contributions require the conversation.ui permission.')
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
    connector: { kind: id === 'git-workbench' ? 'git-cli' : 'package', auth: 'local', setupLabel: id === 'git-workbench' ? 'Uses the Git CLI in the selected workspace' : 'Installed application plugin' },
    bundledSkills: [],
    permissions,
    runtime: { workspace, ...(runtimeAssets.length ? { assets: runtimeAssets } : {}), ...(runtimeExecutables.length ? { executables: runtimeExecutables } : {}) },
    contributes: { views, conversationActions, skills, workers },
    ...(onboarding ? { onboarding } : {}),
    ...(value.experimental === true ? { experimental: true } : {}),
  }
}

async function validatePackageAssets(root: string, manifest: PluginManifest) {
  if (manifest.iconAsset) {
    const path = resolve(root, manifest.iconAsset)
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw Error('Plugin icon escapes its package.')
    if (!(await stat(path)).isFile()) throw Error(`Plugin icon does not exist: ${relative(root, path)}`)
    const source = await readFile(path, 'utf8')
    if (Buffer.byteLength(source) > 256 * 1024 || !/<svg(?:\s|>)/i.test(source)) throw Error('Plugin icon must be a valid SVG no larger than 256 KB.')
  }
  for (const view of manifest.contributes?.views || []) {
    const path = resolve(root, view.entry)
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw Error('Plugin view entry escapes its package.')
    if (!(await stat(path)).isFile()) throw Error(`Plugin view entry does not exist: ${relative(root, path)}`)
  }
  for (const skill of manifest.contributes?.skills || []) {
    const path = resolve(root, skill.path)
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw Error('Plugin Skill path escapes its package.')
    if (!(await stat(path)).isDirectory()) throw Error(`Plugin Skill directory does not exist: ${relative(root, path)}`)
  }
  for (const worker of manifest.contributes?.workers || []) {
    const path = resolve(root, worker.entry)
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw Error('Plugin worker entry escapes its package.')
    if (!(await stat(path)).isFile()) throw Error(`Plugin worker entry does not exist: ${relative(root, path)}`)
  }
  let files = 0, bytes = 0
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), info = await lstat(path)
      if (info.isSymbolicLink()) throw Error(`Plugin packages cannot contain symbolic links: ${relative(root, path)}`)
      if (info.isDirectory()) await walk(path)
      else { files++; bytes += info.size }
    }
  }
  await walk(root)
  if (files > 400 || bytes > 25 * 1024 * 1024) throw Error('Plugin package exceeds the 400-file or 25 MB installation limit.')
}

async function childDirectories(root: string) {
  try {
    return (await readdir(root, { withFileTypes: true })).filter(item => item.isDirectory() && !item.name.startsWith('.')).map(item => join(root, item.name))
  } catch { return [] }
}

function normalizeAssetEntry(value: unknown) {
  const entry = String(value || '').replace(/\\/g, '/')
  if (!entry || entry.startsWith('/') || entry.split('/').some(part => !part || part === '.' || part === '..')) throw Error('Plugin view entry must be a package-relative file path.')
  return entry
}

function requiredText(value: unknown, label: string, maximum: number) {
  const text = String(value || '').trim()
  if (!text || text.length > maximum) throw Error(`Plugin ${label} is missing or too long.`)
  return text
}

function cloneManifest(manifest: PluginManifest): PluginManifest {
  return {
    ...manifest,
    connector: { ...manifest.connector },
    bundledSkills: manifest.bundledSkills.map(item => ({ ...item })),
    permissions: manifest.permissions?.map(item => ({ ...item })),
    runtime: manifest.runtime ? {
      ...manifest.runtime,
      assets: manifest.runtime.assets?.map(item => ({ ...item })),
      executables: manifest.runtime.executables?.map(item => ({ ...item, targets: item.targets.map(target => ({ ...target })) })),
    } : undefined,
    contributes: manifest.contributes ? {
      views: manifest.contributes.views?.map(item => ({ ...item })),
      conversationActions: manifest.contributes.conversationActions?.map(item => ({ ...item })),
      skills: manifest.contributes.skills?.map(item => ({ ...item })),
      workers: manifest.contributes.workers?.map(item => ({ ...item, runtime: item.runtime ? [...item.runtime] : undefined })),
    } : undefined,
    onboarding: manifest.onboarding ? { reopenable: manifest.onboarding.reopenable, steps: manifest.onboarding.steps.map(step => ({ ...step, ...('options' in step ? { options: step.options.map(option => ({ ...option })) } : {}) })) } : undefined,
  }
}

function withIconUrl(manifest: PluginManifest) {
  return manifest.iconAsset ? { ...manifest, iconUrl: `shun-plugin://${manifest.id}/${manifest.iconAsset}` } : manifest
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch { return fallback }
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
