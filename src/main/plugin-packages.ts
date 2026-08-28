import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve, sep } from 'node:path'
import type { PluginManifest, PluginPermission, PluginState, PluginViewContribution, Settings } from '../shared.ts'

type PackageRecord = { manifest: PluginManifest; root: string }

const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const viewIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const permissionIds = new Set<PluginPermission['id']>(['workspace.git.read', 'workspace.git.write', 'workspace.read', 'workspace.reveal', 'conversation.context', 'conversation.ui'])

export class PluginPackageRegistry {
  #records = new Map<string, PackageRecord>()
  #sources = new Map<string, string>()
  #viewGrants = new Map<string, { pluginId: string; viewId: string; permissions: Set<string>; expiresAt: number }>()
  private bundledRoot: string
  private installedRoot: string

  constructor(bundledRoot: string, installedRoot: string) {
    this.bundledRoot = bundledRoot
    this.installedRoot = installedRoot
  }

  async refresh() {
    this.#sources = new Map(Object.entries(await readJson<Record<string, string>>(this.#sourcesFile(), {})).filter((entry): entry is [string, string] => pluginIdPattern.test(entry[0]) && typeof entry[1] === 'string'))
    const records = new Map<string, PackageRecord>()
    for (const [root, source] of [[this.bundledRoot, 'builtin'], [this.installedRoot, 'installed']] as const) {
      for (const directory of await childDirectories(root)) {
        try {
          const manifest = validatePluginPackage(JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')), source)
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
    return [...this.#records.values()].map(item => cloneManifest(item.manifest))
  }

  manifest(pluginId: string) {
    const record = this.#records.get(pluginId)
    return record ? cloneManifest(record.manifest) : undefined
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

  views(settings: Pick<Settings, 'plugins'>): PluginViewContribution[] {
    const now = Date.now()
    for (const [token, grant] of this.#viewGrants) if (grant.expiresAt <= now) this.#viewGrants.delete(token)
    return this.manifests().flatMap(manifest => {
      const installation = settings.plugins?.find(item => item.id === manifest.id && item.enabled !== false)
      if (!installation) return []
      const required = manifest.permissions?.map(item => item.id) || []
      const granted = new Set(installation.permissions || (manifest.source === 'builtin' ? required : []))
      if (required.some(permission => !granted.has(permission))) return []
      return (manifest.contributes?.views || []).map(view => {
        const accessToken = randomUUID()
        this.#viewGrants.set(accessToken, { pluginId: manifest.id, viewId: view.id, permissions: new Set(required), expiresAt: now + 12 * 60 * 60_000 })
        return {
          pluginId: manifest.id,
          viewId: view.id,
          title: view.title,
          location: view.location,
          url: `shun-plugin://${manifest.id}/${view.entry}`,
          icon: manifest.icon,
          permissions: required,
          accessToken,
          experimental: manifest.experimental,
        }
      })
    })
  }

  skillDirectories(settings: Pick<Settings, 'plugins'>) {
    return this.manifests().flatMap(manifest => {
      const installation = settings.plugins?.find(item => item.id === manifest.id && item.enabled !== false)
      const record = this.#records.get(manifest.id)
      if (!installation || !record) return []
      return (manifest.contributes?.skills || []).map(skill => ({ pluginId: manifest.id, path: resolve(record.root, skill.path), icon: manifest.icon }))
    })
  }

  authorizeView(pluginId: string, viewId: string, accessToken: string, permission: PluginPermission['id']) {
    const manifest = this.#records.get(pluginId)?.manifest
    if (!manifest?.contributes?.views?.some(view => view.id === viewId)) throw Error('Unknown plugin view.')
    if (!manifest.permissions?.some(item => item.id === permission)) throw Error(`Plugin is not allowed to use ${permission}.`)
    const grant = this.#viewGrants.get(accessToken)
    if (!grant || grant.expiresAt <= Date.now() || grant.pluginId !== pluginId || grant.viewId !== viewId || !grant.permissions.has(permission)) throw Error('Plugin view authorization is missing or expired.')
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

  async installFromDirectory(source: string) {
    const sourceRoot = resolve(source)
    const manifest = validatePluginPackage(JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8')), 'installed')
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
    const manifest = validatePluginPackage(JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8')), 'installed')
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

  #sourcesFile() { return join(this.installedRoot, '.development-sources.json') }
  async #writeSources() {
    await mkdir(this.installedRoot, { recursive: true })
    await writeFile(this.#sourcesFile(), JSON.stringify(Object.fromEntries(this.#sources), null, 2), { encoding: 'utf8', mode: 0o600 })
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
  const icon = value.icon === 'git' ? 'git' : 'plugin'
  const permissions = Array.isArray(value.permissions) ? value.permissions.map((item: any) => {
    const permission = String(item?.id || '') as PluginPermission['id']
    if (!permissionIds.has(permission)) throw Error(`Unsupported plugin permission: ${permission || '(missing)'}.`)
    return { id: permission, reason: requiredText(item.reason, `permission ${permission} reason`, 300) }
  }) : []
  if (new Set(permissions.map(item => item.id)).size !== permissions.length) throw Error('Plugin permissions must be unique.')
  const views = Array.isArray(value.contributes?.views) ? value.contributes.views.map((item: any) => {
    const viewId = String(item?.id || '')
    if (!viewIdPattern.test(viewId)) throw Error('Plugin view id is invalid.')
    const location = item.location === 'workspace.main' ? 'workspace.main' as const : item.location === 'workspace.right' ? 'workspace.right' as const : null
    if (!location) throw Error(`Unsupported plugin view location: ${item.location || '(missing)'}.`)
    const entry = normalizeAssetEntry(item.entry)
    return { id: viewId, title: requiredText(item.title, `view ${viewId} title`, 100), location, entry }
  }) : []
  if (new Set(views.map((item: { id: string }) => item.id)).size !== views.length) throw Error('Plugin view ids must be unique.')
  const conversationActions = Array.isArray(value.contributes?.conversationActions) ? value.contributes.conversationActions.map((item: any) => {
    const actionId = requiredText(item.id, 'conversation action id', 80)
    if (!viewIdPattern.test(actionId)) throw Error('Plugin conversation action id is invalid.')
    const placement = item.placement === 'composer' ? 'composer' as const : item.placement === 'message' ? 'message' as const : null
    if (!placement) throw Error(`Unsupported conversation action placement: ${item.placement || '(missing)'}.`)
    return { id: actionId, title: requiredText(item.title, 'conversation action title', 100), placement, command: requiredText(item.command, 'conversation action command', 120) }
  }) : []
  if (new Set(conversationActions.map((item: { id: string }) => item.id)).size !== conversationActions.length) throw Error('Plugin conversation action ids must be unique.')
  const skills = Array.isArray(value.contributes?.skills) ? value.contributes.skills.map((item: any) => ({ path: normalizeAssetEntry(item?.path) })) : []
  if (conversationActions.length && !permissions.some(item => item.id === 'conversation.ui')) throw Error('Conversation UI contributions require the conversation.ui permission.')
  const onboarding = validateOnboarding(value.onboarding)
  return {
    id, name, description, version, publisher, icon, source,
    connector: { kind: id === 'git-workbench' ? 'git-cli' : 'package', auth: 'local', setupLabel: id === 'git-workbench' ? 'Uses the Git CLI in the selected workspace' : 'Installed application plugin' },
    bundledSkills: [],
    permissions,
    contributes: { views, conversationActions, skills },
    ...(onboarding ? { onboarding } : {}),
    ...(value.experimental === true ? { experimental: true } : {}),
  }
}

async function validatePackageAssets(root: string, manifest: PluginManifest) {
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
    contributes: manifest.contributes ? {
      views: manifest.contributes.views?.map(item => ({ ...item })),
      conversationActions: manifest.contributes.conversationActions?.map(item => ({ ...item })),
      skills: manifest.contributes.skills?.map(item => ({ ...item })),
    } : undefined,
    onboarding: manifest.onboarding ? { reopenable: manifest.onboarding.reopenable, steps: manifest.onboarding.steps.map(step => ({ ...step, ...('options' in step ? { options: step.options.map(option => ({ ...option })) } : {}) })) } : undefined,
  }
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
