/**
 * Publishing, from the client side.
 *
 * The client knows three things: the folder that was built, the person who asked
 * for it, and the address that comes back. It holds no credential for the service
 * behind that address, never learns an account or a namespace, and has no idea
 * what the service runs on. It speaks one HTTPS API to Shun's own publishing
 * service and nothing else.
 *
 * Requests are authorized by the identity the marketplace already verifies: a
 * confirmed email address plus a device key that signs this exact request. The
 * client therefore stores nothing new — the private half of that identity was
 * created for plugin publishing and never leaves the machine.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

export type SiteVisibility = 'public' | 'password' | 'off'

export type PublishedSite = {
  name: string
  title: string
  url: string
  visibility: SiteVisibility
  files: number
  bytes: number
  publishedAt: number
  revision: number
}

export type SitesStatus = {
  /** False when the publishing service cannot be reached at all. */
  available: boolean
  /** False until this computer has a verified email address bound to it. */
  verified?: boolean
  /** The domain every site answers under, as the service reports it. */
  domain?: string
  sites: PublishedSite[]
  blocker?: string
}

export type PublishRequest = {
  workspace: string
  path: string
  /** Only when the person asked for a particular address. */
  name?: string
  title?: string
  visibility?: unknown
  password?: string
  /** Publish over an address another project already owns. Only on an explicit request. */
  takeOver?: boolean
}

export type PublishResult = {
  site: PublishedSite
  uploaded: number
  unchanged: number
  removed: number
  live: boolean
  message: string
  /** Returned once, when the service issued one. Never stored. */
  password?: string
}

const defaultEndpoint = 'https://sites-api.shunagent.site'
const maxFiles = 5_000
const maxFileBytes = 25 * 1024 * 1024
const maxTotalBytes = 200 * 1024 * 1024
/** One request stays well under the service's body limit. */
const uploadChunkBytes = 6 * 1024 * 1024

export class SitePublishingService {
  readonly #publisher: PublisherSigner
  readonly #fetch: typeof fetch
  readonly #endpoint: string

  constructor(options: { publisher: PublisherSigner, endpoint?: string, fetchUrl?: typeof fetch }) {
    this.#publisher = options.publisher
    this.#endpoint = String(options.endpoint || defaultEndpoint).replace(/\/+$/, '')
    this.#fetch = options.fetchUrl || fetch
  }

  async status(): Promise<SitesStatus> {
    const verified = await this.#publisher.status().then(Boolean, () => false)
    if (!verified) return { available: true, verified: false, sites: [], blocker: 'Publishing needs a verified email address.' }
    try {
      const state = await this.#api('/__api/state', { method: 'GET' })
      return { available: true, verified: true, domain: String(state.domain || ''), sites: normalizeSites(state.sites) }
    } catch (error) {
      return { available: false, verified: true, sites: [], blocker: `The publishing service could not be reached. ${message(error)}` }
    }
  }

  /** Output directories a static site is plausibly sitting in, with its build script. */
  async candidates(workspace: string) {
    const workspaceValue = String(workspace || '').trim()
    if (!workspaceValue) throw Error('Select a workspace first.')
    const root = await realpath(workspaceValue).catch(() => { throw Error('The selected workspace folder is unavailable.') })
    const paths: string[] = []
    for (const name of ['dist', 'build', 'out', '_site', 'public', join('.output', 'public'), 'storybook-static', 'site', 'www']) {
      if (await hasIndex(join(root, name))) paths.push(name.split(sep).join('/'))
    }
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skippedDirectories.has(entry.name) || paths.includes(entry.name)) continue
      if (await hasIndex(join(root, entry.name))) paths.push(entry.name)
    }
    let buildScript = ''
    try {
      const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      buildScript = Object.keys(manifest?.scripts || {}).find(name => /^(?:build|generate|export)$/i.test(name)) || ''
    } catch {}
    return { paths, buildScript }
  }

  async publish(request: PublishRequest): Promise<PublishResult> {
    const root = await this.#resolveTarget(request.workspace, request.path)
    const planned = await planDirectory(root)
    if (!planned.some(file => file.path === 'index.html')) throw Error('A published site needs an index.html at the root of the output directory.')

    const project = await projectIdentity(root)
    const asked = String(request.name || '').trim()
    const suggested = await projectName(root, await realpath(request.workspace).catch(() => request.workspace))
    const resolved = await this.#api('/__api/resolve', {
      method: 'POST',
      body: {
        project,
        ...(asked ? { name: asked } : {}),
        ...(suggested ? { suggest: suggested } : {}),
        takeOver: request.takeOver === true,
      },
    })
    const name = String(resolved.name || '')
    if (!name) throw Error('The publishing service did not return an address.')

    // Only what changed since the last publish travels, and only once.
    const previous = (resolved.manifest && typeof resolved.manifest === 'object' ? resolved.manifest : {}) as Record<string, { hash?: string }>
    const changed = planned.filter(file => previous[file.path]?.hash !== file.sha256)
    const removed = Object.keys(previous).filter(path => !planned.some(file => file.path === path))
    for (let index = 0; index < changed.length;) {
      const chunk: typeof changed = []
      let bytes = 0
      while (index < changed.length) {
        const file = changed[index]
        if (chunk.length && bytes + file.size > uploadChunkBytes) break
        chunk.push(file)
        bytes += file.size
        index++
      }
      await this.#api(`/__api/sites/${encodeURIComponent(name)}/assets`, {
        method: 'PUT',
        body: { project, takeOver: request.takeOver === true, files: chunk.map(file => ({ path: file.path, hash: file.sha256, base64: file.bytes.toString('base64') })) },
      })
    }

    const published = await this.#api(`/__api/sites/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: {
        project,
        manifest: Object.fromEntries(planned.map(file => [file.path, { hash: file.sha256, size: file.size }])),
        removed,
        title: request.title,
        visibility: request.visibility,
        password: request.password,
        takeOver: request.takeOver === true,
      },
    })
    const site = normalizeSite(published.site)
    const issued = typeof published.password === 'string' ? published.password : undefined
    const live = site ? await this.#reachable(site.url) : false
    const substituted = site && (asked || suggested) && site.name !== (asked || suggested)
    return {
      site,
      uploaded: changed.length,
      unchanged: planned.length - changed.length,
      removed: removed.length,
      live,
      ...(issued ? { password: issued } : {}),
      message: [
        substituted ? `${suggested} was taken, so this site has its own address.` : '',
        live ? `Published ${planned.length} files to ${site.url}` : `Uploaded ${planned.length} files to ${site.url}, but the address did not answer yet.`,
      ].filter(Boolean).join(' '),
    }
  }

  async setAccess(input: { name: string, visibility: unknown, password?: string }) {
    const mode = normalizeVisibility(input.visibility)
    if (!mode) throw Error('Choose public, password, or off.')
    const result = await this.#api(`/__api/sites/${encodeURIComponent(normalizeName(input.name))}/visibility`, {
      method: 'POST',
      body: { visibility: mode, password: input.password },
    })
    const site = normalizeSite(result.site)
    const issued = typeof result.password === 'string' ? result.password : undefined
    return { ...site, ...(issued ? { password: issued } : {}) }
  }

  /** Everything stored for a site is gone afterwards; the address stops answering. */
  async remove(nameValue: string) {
    return this.#api(`/__api/sites/${encodeURIComponent(normalizeName(nameValue))}`, { method: 'DELETE', body: {} })
  }

  async urlFor(nameValue: string) {
    const name = normalizeName(nameValue)
    const state = await this.#api('/__api/state', { method: 'GET' })
    const site = normalizeSites(state.sites).find(item => item.name === name)
    if (!site) throw Error(`No published site is named ${nameValue}.`)
    return site.url
  }

  async #resolveTarget(workspace: string, requested: string) {
    const workspaceValue = String(workspace || '').trim()
    if (!workspaceValue) throw Error('Select a workspace before publishing.')
    const root = await realpath(workspaceValue).catch(() => { throw Error('The selected workspace folder is unavailable.') })
    const target = await realpath(resolve(root, String(requested || '.').trim() || '.')).catch(() => { throw Error(`The publish folder is unavailable: ${requested || '.'}`) })
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw Error('The publish folder must live inside the selected workspace.')
    if (!(await stat(target)).isDirectory()) throw Error('The publish target must be a directory of static files.')
    return target
  }

  async #api(path: string, options: { method: string, body?: unknown }) {
    const body = options.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(options.body))
    const headers = new Headers({ accept: 'application/json' })
    if (options.body !== undefined) headers.set('content-type', 'application/json')
    // The signature covers this method, this path, and these exact bytes.
    try {
      headers.set('authorization', await this.#publisher.authorization(options.method, path, body))
    } catch {
      throw Error('Publishing needs a verified email address. Verify one here in the conversation, then publish again.')
    }
    const response = await this.#fetch(`${this.#endpoint}${path}`, {
      method: options.method,
      headers,
      ...(options.body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(120_000),
    })
    const text = await response.text()
    let value: any
    try { value = text ? JSON.parse(text) : {} } catch { value = {} }
    if (!response.ok) throw Error(String(value?.error || `The publishing service answered ${response.status}.`).slice(0, 400))
    return value
  }

  /** A published address has to answer before it is reported as published. */
  async #reachable(url: string) {
    try {
      const response = await this.#fetch(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } })
      return response.status === 200 || response.status === 401
    } catch { return false }
  }
}

/** The signing half of the identity this product already verifies. */
export type PublisherSigner = {
  status(): Promise<unknown>
  authorization(method: string, path: string, body: Uint8Array): Promise<string>
}

export function normalizeVisibility(value: unknown): SiteVisibility | undefined {
  const text = String(value || '').trim().toLowerCase()
  return text === 'public' || text === 'password' || text === 'off' ? text as SiteVisibility : undefined
}

export function slugify(value: string) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'site'
}

function normalizeName(value: unknown) {
  const name = String(value || '').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(name)) throw Error('Enter a valid site address.')
  return name
}

function normalizeSite(value: any): PublishedSite {
  return {
    name: String(value?.name || ''),
    title: String(value?.title || value?.name || ''),
    url: String(value?.url || ''),
    visibility: normalizeVisibility(value?.visibility) || 'public',
    files: Number(value?.files) || 0,
    bytes: Number(value?.bytes) || 0,
    publishedAt: Number(value?.publishedAt) || 0,
    revision: Number(value?.revision) || 0,
  }
}

function normalizeSites(value: unknown): PublishedSite[] {
  return (Array.isArray(value) ? value : []).map(normalizeSite).filter(site => site.name)
}

const skippedDirectories = new Set(['node_modules', '.git'])

async function planDirectory(root: string) {
  const files: Array<{ path: string, size: number, sha256: string, bytes: Buffer }> = []
  let total = 0
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue
      const path = join(directory, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const info = await lstat(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        if (skippedDirectories.has(entry.name)) continue
        await walk(path, relativePath)
        continue
      }
      if (!info.isFile()) continue
      if (info.size > maxFileBytes) throw Error(`${relativePath} is larger than the 25 MiB a single file can be.`)
      total += info.size
      if (total > maxTotalBytes) throw Error('This site is larger than the 200 MB one publish can carry. Publish a smaller build.')
      if (files.length >= maxFiles) throw Error(`This site has more than ${maxFiles} files. Publish a smaller build.`)
      const bytes = await readFile(path)
      files.push({ path: relativePath, size: info.size, sha256: sha256(bytes), bytes })
    }
  }
  await walk(root, '')
  return files
}

/**
 * The project a publish folder belongs to: the nearest enclosing source root, so
 * `dist` and `build` of one project are one project, and its folder name is the
 * name a person would recognize as the address.
 */
async function projectHome(root: string) {
  let current = root
  for (let depth = 0; depth < 6; depth++) {
    for (const marker of ['.git', 'package.json']) {
      if (await stat(join(current, marker)).then(() => true, () => false)) return current
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return root
}

/** Folders that say what a build produced, never what the project is. */
const buildFolders = new Set(['dist', 'build', 'out', 'output', 'public', '_site', 'storybook-static', 'html', 'htdocs', 'web', 'static', 'site'])

/**
 * The name a person would recognize. A publish usually points at `dist` or
 * `build`, so the address comes from the project above it — walking up until the
 * name stops describing a build step, and never past the workspace.
 */
async function projectName(root: string, workspaceRoot: string) {
  const boundary = workspaceRoot || root
  let current = await projectHome(root)
  for (let depth = 0; depth < 8; depth++) {
    const name = slugify(basename(current))
    if (!buildFolders.has(name)) return name
    const parent = dirname(current)
    if (parent === current || current === boundary) break
    current = parent
  }
  const fallback = slugify(basename(boundary))
  return buildFolders.has(fallback) ? 'site' : fallback
}

async function projectIdentity(root: string) {
  return sha256(await projectHome(root))
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

async function hasIndex(directory: string) {
  return stat(join(directory, 'index.html')).then(info => info.isFile(), () => false)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
