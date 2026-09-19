import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import type { PluginManifest, PluginPermission, PluginProvenance, PluginRuntimeAsset, PluginRuntimeExecutable, PluginRuntimeExecutableTarget, PluginState, PluginViewContribution, PluginViewDescriptor, PluginViewLaunchSource, PluginViewManifest, PluginWorkspaceRequirement, Settings } from '../shared.ts'
import { pluginPackageDigest } from './plugin-archive.ts'
import { pluginIdPattern, pluginPermissionIds, validatePluginPackage, viewIdPattern } from '../plugin-manifest.ts'
import { satisfiesShunEngine } from '../plugin-engines.ts'

export { normalizePermissionGrants, validatePluginPackage } from '../plugin-manifest.ts'

type PackageRecord = { manifest: PluginManifest; root: string }
export type PluginRuntimeAssetDescriptor = PluginRuntimeAsset & { cachePath: string; developmentPath?: string }
export type PluginRuntimeExecutableDescriptor = PluginRuntimeExecutableTarget & { id: string; version: string; cachePath: string; developmentPath?: string }

/** Where an installed package came from. */
export type PluginPackageOrigin = PluginProvenance['source']
/** What is installed on this machine, so an update can be recognized as one. */
export type PluginPackageProvenance = PluginProvenance


export class PluginPackageRegistry {
  #records = new Map<string, PackageRecord>()
  #sources = new Map<string, string>()
  #viewGrants = new Map<string, { pluginId: string; viewId: string; workspace: string; taskId: string; permissions: Set<string>; expiresAt: number }>()
  #installations = new Map<string, PluginPackageProvenance>()
  private bundledRoot: string
  private installedRoot: string
  private runtimeAssetsRoot: string
  /** Last replaced copy of each installed package, kept for one-click restore. */
  private previousRoot: string
  /**
   * The running Shun version, used to gate packages that declare
   * `engines.shun`. Leaving it empty disables gating, which is only for
   * callers that deliberately do not model host compatibility.
   */
  private hostVersion: string

  constructor(bundledRoot: string, installedRoot: string, runtimeAssetsRoot = join(installedRoot, '.runtime-assets'), hostVersion = '') {
    this.bundledRoot = bundledRoot
    this.installedRoot = installedRoot
    this.runtimeAssetsRoot = runtimeAssetsRoot
    this.previousRoot = join(installedRoot, '.previous')
    this.hostVersion = hostVersion
  }

  async refresh() {
    this.#sources = new Map(Object.entries(await readJson<Record<string, string>>(this.#sourcesFile(), {})).filter((entry): entry is [string, string] => pluginIdPattern.test(entry[0]) && typeof entry[1] === 'string'))
    this.#installations = new Map(Object.entries(await readJson<Record<string, PluginPackageProvenance>>(this.#installationsFile(), {})).filter((entry): entry is [string, PluginPackageProvenance] => pluginIdPattern.test(entry[0]) && Boolean(entry[1]) && typeof entry[1] === 'object'))
    const records = new Map<string, PackageRecord>()
    for (const [root, source] of [[this.bundledRoot, 'builtin'], [this.installedRoot, 'installed']] as const) {
      for (const directory of await childDirectories(root)) {
        try {
          const manifest = validatePluginPackage(await readPluginManifest(directory), source)
          if (!this.#engineSatisfied(manifest)) continue
          if (!records.has(manifest.id) || source === 'builtin') records.set(manifest.id, { manifest, root: directory })
        } catch (error) {
          console.warn('[plugin-package]', directory, error instanceof Error ? error.message : error)
        }
      }
    }
    this.#records = records
    return this.manifests()
  }

  /**
   * Installing a package that rejects this build cannot make it work, so the
   * package stays off the shelf: bundled packages fail at startup with a
   * warning, installed packages fail with an error the user can act on.
   */
  #engineSatisfied(manifest: PluginManifest) {
    if (!this.hostVersion) return true
    const range = manifest.engines?.shun
    if (satisfiesShunEngine(this.hostVersion, range)) return true
    console.warn('[plugin-package]', manifest.id, `requires Shun ${range}; this build is ${this.hostVersion}`)
    return false
  }

  #requireEngine(manifest: PluginManifest) {
    if (!this.#engineSatisfied(manifest)) throw Error(`${manifest.name} requires Shun ${manifest.engines?.shun}, but this build is ${this.hostVersion}.`)
  }

  /** Provenance of the package installed under this id, when it was recorded. */
  installation(pluginId: string) {
    const record = this.#installations.get(pluginId)
    return record ? { ...record } : undefined
  }

  /** The version an update replaced, while it is still on disk. */
  async previous(pluginId: string) {
    const record = this.#installations.get(pluginId)
    if (!record?.previous) return undefined
    const exists = await stat(join(this.previousRoot, pluginId)).then(() => true, () => false)
    return exists ? { ...record.previous } : undefined
  }

  /** Put the replaced version back, so a bad update is one action to undo. */
  async restorePrevious(pluginId: string) {
    const record = this.#installations.get(pluginId)
    if (!record?.previous) throw Error('There is no previous version of this plugin to restore.')
    const source = join(this.previousRoot, pluginId)
    if (!(await stat(source).then(() => true, () => false))) throw Error('The previous version of this plugin is no longer on disk.')
    const manifest = await this.installFromDirectory(source, record.previous.source)
    await rm(source, { recursive: true, force: true })
    return manifest
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
      const provenance = this.#installations.get(manifest.id)
      return {
        ...manifest,
        installed: Boolean(installation),
        enabled: Boolean(installation) && installation?.enabled !== false,
        detail: manifest.connector.setupLabel,
        ...(provenance ? { provenance: { ...provenance } } : {}),
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
      // Only the always-present tier grants its permissions implicitly. A plugin
      // the user chooses to install asks for consent exactly like a marketplace
      // package, so an update can never widen access without being seen.
      const implicit = manifest.distribution === 'required' ? required : []
      const granted = new Set(installation.permissions || implicit)
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
    if (!view) throw Error(`That view cannot be opened: ${this.#viewRefusal(settings, pluginId, viewId)}.`)
    if (view.workspace === 'required' && !workspace) throw Error('This plugin view requires a selected workspace.')
    const boundWorkspace = view.workspace === 'none' ? '' : workspace
    const accessToken = randomUUID()
    const instanceUrl = new URL(view.url)
    instanceUrl.searchParams.set('instance', randomUUID())
    const boundTaskId = String(taskId || '')
    this.#viewGrants.set(accessToken, { pluginId, viewId, workspace: boundWorkspace, taskId: boundTaskId, permissions: new Set(view.permissions), expiresAt: Date.now() + 12 * 60 * 60_000 })
    return { ...view, url: instanceUrl.href, accessToken, boundWorkspace, boundTaskId }
  }

  /**
   * Why a view is not there, in the terms that name the actual obstacle. "Unavailable or
   * missing grants" is only ever true of one of these four, and a reader who is told which
   * one can act; a reader who is told the generic sentence cannot.
   */
  #viewRefusal(settings: Pick<Settings, 'plugins'>, pluginId: string, viewId: string) {
    const manifest = this.#records.get(pluginId)?.manifest
    if (!manifest) return `this build has no plugin package called "${pluginId}"`
    if (!manifest.contributes?.views?.some(entry => entry.id === viewId)) return `plugin "${pluginId}" has no view called "${viewId}"`
    const installation = settings.plugins?.find(item => item.id === pluginId)
    if (!installation || installation.enabled === false) return `plugin "${pluginId}" is not enabled for this task`
    return `plugin "${pluginId}" is missing the permission grants its view needs`
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

  async installFromDirectory(source: string, origin: PluginPackageOrigin = 'directory') {
    const sourceRoot = resolve(source)
    const manifest = validatePluginPackage(await readPluginManifest(sourceRoot), 'installed')
    if (this.#records.get(manifest.id)?.manifest.source === 'builtin') throw Error(`Plugin id ${manifest.id} is reserved by a built-in package.`)
    this.#requireEngine(manifest)
    await validatePackageAssets(sourceRoot, manifest)
    const digest = await pluginPackageDigest(sourceRoot)
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
    if (replacing) {
      // Keep exactly one previous copy: an update the user regrets is a restore
      // away, which is the cheapest possible insurance for a store install.
      const previousRoot = join(this.previousRoot, manifest.id)
      await rm(previousRoot, { recursive: true, force: true })
      await mkdir(this.previousRoot, { recursive: true })
      await cp(previous, previousRoot, { recursive: true }).catch(error => console.warn('[plugin-package]', 'could not keep the previous version:', error instanceof Error ? error.message : error))
      await rm(previous, { recursive: true, force: true })
    }
    this.#sources.set(manifest.id, sourceRoot)
    await this.#writeSources()
    const previousRecord = replacing ? this.#installations.get(manifest.id) : undefined
    this.#installations.set(manifest.id, {
      version: manifest.version, publisher: manifest.publisher, sha256: digest.sha256, files: digest.files, bytes: digest.bytes,
      installedAt: Date.now(), source: origin,
      ...(previousRecord ? { previous: { version: previousRecord.version, sha256: previousRecord.sha256, installedAt: previousRecord.installedAt, source: previousRecord.source } } : {}),
    })
    await this.#writeInstallations()
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
    await rm(join(this.previousRoot, pluginId), { recursive: true, force: true })
    this.#sources.delete(pluginId)
    this.#installations.delete(pluginId)
    for (const [token, grant] of this.#viewGrants) if (grant.pluginId === pluginId) this.#viewGrants.delete(token)
    await this.#writeSources()
    await this.#writeInstallations()
    await this.refresh()
    return true
  }

  #sourcesFile() { return join(this.installedRoot, '.development-sources.json') }
  async #writeSources() {
    await mkdir(this.installedRoot, { recursive: true })
    await writeFile(this.#sourcesFile(), JSON.stringify(Object.fromEntries(this.#sources), null, 2), { encoding: 'utf8', mode: 0o600 })
  }

  #installationsFile() { return join(this.installedRoot, '.installations.json') }
  async #writeInstallations() {
    await mkdir(this.installedRoot, { recursive: true })
    await writeFile(this.#installationsFile(), JSON.stringify(Object.fromEntries(this.#installations), null, 2), { encoding: 'utf8', mode: 0o600 })
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


