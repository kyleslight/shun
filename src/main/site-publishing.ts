/**
 * Sites publishing: the desktop half of the built-in Sites plugin.
 *
 * Deliberately not a second Cloudflare tool surface. The public gateway Worker
 * this provisions is read-only, and every write — the host map, the site
 * record, the asset bytes — is made here through the Cloudflare API with the
 * account owner's own token. That is what keeps "publish" an explicit local
 * action instead of a network endpoint anyone can reach.
 *
 * Cost posture decides the shape: one wildcard host binding and one KV
 * namespace serve every site, so a second published site adds no DNS record,
 * no certificate, and no Cloudflare resource.
 */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { PluginConnectionState } from '../shared.ts'
import type { CloudflareApi } from './cloudflare-rest.ts'

export type SiteVisibility = 'public' | 'password' | 'off'

export type SitesConfig = {
  accountId: string
  zoneId: string
  zoneName: string
  /** Every site answers at `<slug>.<baseDomain>`. */
  baseDomain: string
  /** True when sites sit two levels below the zone apex, which Universal SSL does not cover. */
  certificateWarning: boolean
  namespaceId: string
  scriptName: string
  hostBinding: 'custom-domain' | 'route'
  configuredAt: number
}

export type PublishedSite = {
  slug: string
  title: string
  host: string
  url: string
  visibility: SiteVisibility
  files: number
  bytes: number
  publishedAt: number
  revision: number
}

export type SitesStatus = {
  connection: PluginConnectionState
  config?: SitesConfig
  sites: PublishedSite[]
  /** What the panel should ask the user to do next, when anything is missing. */
  blocker?: string
  warning?: string
}

export type PublishRequest = {
  workspace: string
  path: string
  slug?: string
  title?: string
  visibility?: unknown
  password?: string
  /** Only needed when the token can see more than one zone and none is configured yet. */
  baseDomain?: string
}

export type PublishResult = { site: PublishedSite, uploaded: number, unchanged: number, removed: number, live: boolean, message: string, password?: string, setup?: { zoneName: string, baseDomain: string } }

type StoredConfig = { version: 1; config?: SitesConfig }

/** A static site's own budget: what one publish may carry and one KV account can hold. */
const maxFiles = 5_000
const maxFileBytes = 25 * 1024 * 1024
const maxTotalBytes = 200 * 1024 * 1024
const kvWriteChunk = 200
const kvWriteChunkBytes = 20 * 1024 * 1024
const purgeChunk = 30
const purgeBudget = 60
const skippedDirectories = new Set(['node_modules', '.git'])
const reservedSlugs = new Set(['www', 'api', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'cdn', 'admin', 'root', 'ns', 'ns1', 'ns2', 'dns', 'mx', 'status', 'support', 'help', 'docs', 'blog', 'shop', 'dev', 'staging', 'test', 'localhost', 'assets', 'static', 'edge', 'workers', 'pages', 'registry', 'updates', 'release', 'internal', 'health', 'gateway', 'sites'])
const contentTypes: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf', wasm: 'application/wasm', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', csv: 'text/csv; charset=utf-8', webmanifest: 'application/manifest+json',
  zip: 'application/zip',
}

export class SitePublishingService {
  readonly #api: CloudflareApi
  readonly #configFile: string
  readonly #readGatewaySource: () => Promise<string>
  readonly #fetchUrl: typeof fetch
  readonly #now: () => number

  constructor(api: CloudflareApi, options: { configFile: string; readGatewaySource: () => Promise<string>; fetchUrl?: typeof fetch; now?: () => number }) {
    this.#api = api
    this.#configFile = options.configFile
    this.#readGatewaySource = options.readGatewaySource
    this.#fetchUrl = options.fetchUrl || fetch
    this.#now = options.now || Date.now
  }

  async status(): Promise<SitesStatus> {
    const connection = await this.#api.state()
    if (!connection.connected) {
      return { connection, sites: [], blocker: connection.status === 'error' ? connection.message : 'Cloudflare is not connected yet. Connect it in Plugins, then come back.' }
    }
    const config = await this.config()
    if (!config) return { connection, sites: [], blocker: 'Choose a Cloudflare zone to start publishing.' }
    return { connection, config, sites: await this.#sites(config), ...(config.certificateWarning ? { warning: certificateWarning(config) } : {}) }
  }

  async config() {
    return (await readJson<StoredConfig>(this.#configFile, { version: 1 })).config
  }

  /** Zones the connected token can publish into, with the account each belongs to. */
  async zones() {
    const response = await this.#api.request('/zones?page=1&per_page=50')
    return (response.result || []).map((zone: any) => ({
      id: String(zone.id),
      name: String(zone.name),
      accountId: String(zone.account?.id || ''),
      accountName: String(zone.account?.name || ''),
    }))
  }

  /**
   * Idempotent setup: create what is missing, reuse what exists, and report the
   * host binding that actually took effect instead of the one that was planned.
   */
  async setup(input: { zoneId?: string, baseDomain?: string } = {}) {
    const zone = await this.#resolveZone(input.zoneId, input.baseDomain)
    const zoneId = zone.id
    const baseDomain = (String(input.baseDomain || '').trim() || zone.name).toLowerCase().replace(/\.$/, '')
    if (baseDomain !== zone.name && !baseDomain.endsWith(`.${zone.name}`)) throw Error(`The publishing domain must be ${zone.name} or a subdomain of it.`)
    if (!/^[a-z0-9.-]+$/.test(baseDomain)) throw Error('The publishing domain may contain only letters, digits, dots, and hyphens.')

    const namespaceId = await this.#ensureNamespace(zone.accountId)
    const scriptName = 'shun-sites-gateway'
    await this.#uploadGateway(zone.accountId, scriptName, namespaceId)
    const hostBinding = await this.#attachHost(zone.accountId, zoneId, baseDomain, scriptName)
    const config: SitesConfig = {
      accountId: zone.accountId, zoneId, zoneName: zone.name, baseDomain,
      certificateWarning: baseDomain !== zone.name,
      namespaceId, scriptName, hostBinding, configuredAt: this.#now(),
    }
    await this.#writeConfig(config)

    const probed = await this.#probe(baseDomain)
    return {
      config,
      verified: probed.ok,
      message: probed.ok ? `Publishing is ready at ${baseDomain}.` : `Publishing is set up, but ${baseDomain} did not answer yet: ${probed.message}`,
      ...(config.certificateWarning ? { warning: certificateWarning(config) } : {}),
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
    // Publishing is the request people actually make, so it sets publishing up on
    // first use rather than answering with an instruction to go and configure it.
    const configured = await this.config()
    const provisioned = configured ? undefined : await this.setup({ baseDomain: request.baseDomain })
    const config = provisioned?.config || configured
    if (!config) throw Error('Cloudflare is not connected, so publishing cannot be set up.')
    const root = await this.#resolveInside(request.workspace, request.path)
    const planned = await planDirectory(root)
    if (!planned.some(file => file.path === 'index.html')) throw Error('A published site needs an index.html at the root of the output directory.')
    const slug = await this.#resolveSlug(config, request.slug, root)
    const previous = await this.#siteManifest(config, slug)
    const changed = planned.filter(file => previous[file.path]?.sha256 !== file.sha256)
    const removed = Object.keys(previous).filter(path => !planned.some(file => file.path === path))

    for (let index = 0; index < changed.length; index += kvWriteChunk) {
      await this.#kvBulkPut(config, changed.slice(index, index + kvWriteChunk).map(file => ({
        key: `a:${slug}/${file.path}`,
        value: file.bytes,
        metadata: { sha256: file.sha256, type: contentType(file.path) },
      })))
    }
    for (let index = 0; index < removed.length; index += kvWriteChunk) await this.#kvBulkDelete(config, removed.slice(index, index + kvWriteChunk).map(path => `a:${slug}/${path}`))

    const existing = await this.#siteRecord(config, slug)
    const visibility = normalizeVisibility(request.visibility) || existing?.visibility || 'public'
    // The plaintext a generated password returns is never stored: only its salted
    // hash reaches Cloudflare, and the password itself is handed back once.
    const { password: issued, ...secret } = await this.#secret(visibility, request.password, existing)
    const host = `${slug}.${config.baseDomain}`
    const record = {
      slug,
      title: String(request.title || existing?.title || slug).trim().slice(0, 120) || slug,
      host,
      url: `https://${host}/`,
      visibility,
      files: planned.length,
      bytes: planned.reduce((total, file) => total + file.size, 0),
      publishedAt: this.#now(),
      revision: (existing?.revision || 0) + 1,
      ...secret,
    }
    await this.#kvPut(config, `f:${slug}`, JSON.stringify(Object.fromEntries(planned.map(file => [file.path, { sha256: file.sha256, size: file.size }]))))
    await this.#kvPut(config, `s:${slug}`, JSON.stringify(record))
    await this.#kvPut(config, `h:${host}`, JSON.stringify({ slug, title: record.title, visibility, ...secret }))
    await this.#writeIndex(config, [...(await this.#index(config)), slug])

    await this.#purge(config, [record.url, ...changed.slice(0, purgeBudget - 1).map(file => `https://${host}/${file.path}`)])
    const live = await this.#verifyUrl(record.url)
    return {
      site: publicSite(record), uploaded: changed.length, unchanged: planned.length - changed.length, removed: removed.length, live,
      ...(issued ? { password: issued } : {}),
      ...(provisioned ? { setup: { zoneName: config.zoneName, baseDomain: config.baseDomain } } : {}),
      message: [
        provisioned ? `Set up publishing under ${config.baseDomain}.` : '',
        live ? `Published ${planned.length} files to ${record.url}` : `Uploaded ${planned.length} files to ${record.url}, but the address did not answer yet.`,
      ].filter(Boolean).join(' '),
    }
  }

  async setAccess(input: { slug: string, visibility: unknown, password?: string }) {
    const config = await this.#requireConfig()
    const slug = normalizeSlug(input.slug)
    const existing = await this.#siteRecord(config, slug)
    if (!existing) throw Error(`No published site is named ${slug}.`)
    const visibility = normalizeVisibility(input.visibility)
    if (!visibility) throw Error('Choose public, password, or off.')
    const { password: issued, ...secret } = await this.#secret(visibility, input.password, existing)
    const record = { ...existing, visibility, ...secret, revision: (existing.revision || 0) + 1 }
    await this.#kvPut(config, `s:${slug}`, JSON.stringify(record))
    await this.#kvPut(config, `h:${existing.host}`, JSON.stringify({ slug, title: record.title, visibility, ...secret }))
    await this.#purge(config, [existing.url])
    return { ...publicSite(record), ...(issued ? { password: issued } : {}) }
  }

  /** Taking a site down removes everything it stored; the address stops answering at once. */
  async remove(slugValue: string) {
    const config = await this.#requireConfig()
    const slug = normalizeSlug(slugValue)
    const existing = await this.#siteRecord(config, slug)
    const keys = Object.keys(await this.#siteManifest(config, slug)).map(path => `a:${slug}/${path}`)
    for (let index = 0; index < keys.length; index += kvWriteChunk) await this.#kvBulkDelete(config, keys.slice(index, index + kvWriteChunk))
    await this.#kvDelete(config, `f:${slug}`)
    await this.#kvDelete(config, `s:${slug}`)
    if (existing?.host) await this.#kvDelete(config, `h:${existing.host}`)
    await this.#writeIndex(config, (await this.#index(config)).filter(item => item !== slug))
    if (existing?.url) await this.#purge(config, [existing.url])
    return { slug, files: keys.length }
  }

  async urlFor(slugValue: string) {
    const config = await this.#requireConfig()
    const site = await this.#siteRecord(config, normalizeSlug(slugValue))
    if (!site) throw Error(`No published site is named ${slugValue}.`)
    return site.url
  }

  /**
   * A conversation says "publish under shunagent.site", not a zone id, so the
   * zone is resolved from what was said: an explicit id, the configured zone, the
   * zone the named domain belongs to, or the single zone the token can see.
   * Anything ambiguous becomes a question rather than a guess.
   */
  async #resolveZone(zoneIdValue: unknown, baseDomainValue?: unknown) {
    const zones = await this.zones()
    if (!zones.length) throw Error('The connected Cloudflare token cannot see any zone. Add the domain to this Cloudflare account first.')
    const requested = String(zoneIdValue || '').trim()
    if (requested) {
      const wanted = cloudflareId(requested, 'zone')
      const zone = zones.find((item: { id: string, name: string }) => item.id === wanted)
      if (!zone) throw Error('That zone is not visible to the connected Cloudflare token.')
      return zone
    }
    const configured = await this.config()
    const configuredZone = configured && zones.find((item: { id: string, name: string }) => item.id === configured.zoneId)
    if (configuredZone) return configuredZone
    const named = String(baseDomainValue || '').trim().toLowerCase().replace(/\.$/, '')
    const namedZone = named && zones.find((item: { id: string, name: string }) => named === item.name || named.endsWith(`.${item.name}`))
    if (namedZone) return namedZone
    if (zones.length === 1) return zones[0]
    throw Error(`Which domain should hold the sites? The token can see ${zones.map((item: { name: string }) => item.name).join(', ')}.`)
  }

  async #requireConfig() {
    const config = await this.config()
    if (!config) throw Error('Publishing is not set up yet. Publishing a site sets it up, or it can be set up directly with a zone.')
    return config
  }

  async #resolveInside(workspace: string, requested: string) {
    const workspaceValue = String(workspace || '').trim()
    if (!workspaceValue) throw Error('Select a workspace before publishing.')
    const root = await realpath(workspaceValue).catch(() => { throw Error('The selected workspace folder is unavailable.') })
    const target = await realpath(resolve(root, String(requested || '.').trim() || '.')).catch(() => { throw Error(`The publish folder is unavailable: ${requested || '.'}`) })
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw Error('The publish folder must live inside the selected workspace.')
    if (!(await stat(target)).isDirectory()) throw Error('The publish target must be a directory of static files.')
    return target
  }

  /**
   * A slug comes from the project folder, is never silently renamed on
   * republish, and is refused when the zone already answers on that host with a
   * record that is not ours.
   */
  async #resolveSlug(config: SitesConfig, requested: unknown, root: string) {
    const name = String(requested || '').trim()
    const slug = normalizeSlug(name || root.split(sep).pop() || 'site')
    if (await this.#siteRecord(config, slug)) return slug
    const host = `${slug}.${config.baseDomain}`
    const listed = await this.#api.request(`/zones/${config.zoneId}/dns_records?per_page=100&name=${encodeURIComponent(host)}`)
    const conflict = (listed.result || []).find((record: any) => record.name === host)
    if (conflict) throw Error(`${host} already exists in this zone as a ${conflict.type} record. Choose another site name.`)
    return slug
  }

  /**
   * Protection is something a person asks for in a sentence, so a request without
   * a password is answered with a generated one rather than a form: it is stored
   * as a salted hash and returned exactly once, in the result, for the user to
   * keep. Re-selecting the mode keeps the password that already works.
   */
  async #secret(visibility: SiteVisibility, password: string | undefined, existing?: { salt?: string, hash?: string } | null) {
    if (visibility !== 'password') return {}
    const provided = String(password || '').trim()
    const salt = existing?.salt || randomBytes(16).toString('hex')
    if (!provided) {
      if (existing?.hash) return { salt, hash: existing.hash }
      const generated = generatedPassword()
      return { salt, hash: sha256(`${salt}${generated}`), password: generated }
    }
    if (provided.length < 4 || provided.length > 200) throw Error('Choose a password of 4 to 200 characters.')
    return { salt, hash: sha256(`${salt}${provided}`) }
  }

  async #index(config: SitesConfig) {
    const value = await this.#kvJson<string[]>(config, 'index')
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  }

  async #writeIndex(config: SitesConfig, slugs: string[]) {
    await this.#kvPut(config, 'index', JSON.stringify([...new Set(slugs)].sort()))
  }

  async #sites(config: SitesConfig) {
    const records = await Promise.all((await this.#index(config)).map(slug => this.#siteRecord(config, slug).catch(() => undefined)))
    return records.filter(Boolean).map(record => publicSite(record!)).sort((left, right) => right.publishedAt - left.publishedAt)
  }

  #siteRecord(config: SitesConfig, slug: string) {
    return this.#kvJson<PublishedSite & { salt?: string, hash?: string }>(config, `s:${slug}`)
  }

  #siteManifest(config: SitesConfig, slug: string) {
    return this.#kvJson<Record<string, { sha256: string, size: number }>>(config, `f:${slug}`).then(value => value || {})
  }

  async #ensureNamespace(accountId: string) {
    const listed = await this.#api.request(`/accounts/${accountId}/storage/kv/namespaces?page=1&per_page=100`).catch(error => {
      throw scopeError(error, 'Workers KV Storage: Edit (account level)')
    })
    const existing = (listed.result || []).find((namespace: any) => namespace.title === 'shun-sites')
    if (existing) return String(existing.id)
    const created = await this.#api.request(`/accounts/${accountId}/storage/kv/namespaces`, { method: 'POST', body: JSON.stringify({ title: 'shun-sites' }) }).catch(error => {
      throw scopeError(error, 'Workers KV Storage: Edit (account level)')
    })
    const id = String(created.result?.id || '')
    if (!id) throw Error('Cloudflare did not return a KV namespace id.')
    return id
  }

  async #uploadGateway(accountId: string, scriptName: string, namespaceId: string) {
    const source = await this.#readGatewaySource()
    const metadata = {
      main_module: 'worker.mjs',
      compatibility_date: '2024-11-01',
      bindings: [{ type: 'kv_namespace', name: 'SITES', namespace_id: namespaceId }],
    }
    const body = new FormData()
    body.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    body.set('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs')
    await this.#api.request(`/accounts/${accountId}/workers/scripts/${scriptName}`, { method: 'PUT', body }).catch(error => {
      throw scopeError(error, 'Workers Scripts: Edit (account level)')
    })
  }

  /**
   * One wildcard binding serves every site. A Workers custom domain is tried
   * first because Cloudflare then owns the DNS record; a zone route over a
   * proxied wildcard record is the fallback. Which one took effect is recorded,
   * and the probe below — not this function — decides whether it works.
   */
  async #attachHost(accountId: string, zoneId: string, baseDomain: string, scriptName: string): Promise<SitesConfig['hostBinding']> {
    const hostname = `*.${baseDomain}`
    const bound = await this.#api.request(`/accounts/${accountId}/workers/domains`, {
      method: 'PUT',
      body: JSON.stringify({ zone_id: zoneId, hostname, service: scriptName, environment: 'production' }),
    }).then(() => true, () => false)
    if (bound) return 'custom-domain'

    const existing = await this.#api.request(`/zones/${zoneId}/dns_records?per_page=100&name=${encodeURIComponent(hostname)}`)
    if (!(existing.result || []).length) {
      await this.#api.request(`/zones/${zoneId}/dns_records`, {
        method: 'POST',
        body: JSON.stringify({ type: 'AAAA', name: hostname, content: '100::', proxied: true, comment: 'Shun Sites wildcard' }),
      })
    }
    const pattern = `${hostname}/*`
    const routes = await this.#api.request(`/zones/${zoneId}/workers/routes`).catch(error => {
      throw scopeError(error, 'Workers Routes: Edit (zone level)')
    })
    const current = (routes.result || []).find((route: any) => route.pattern === pattern)
    if (current) await this.#api.request(`/zones/${zoneId}/workers/routes/${current.id}`, { method: 'PUT', body: JSON.stringify({ pattern, script: scriptName }) }).catch(error => { throw scopeError(error, 'Workers Routes: Edit (zone level)') })
    else await this.#api.request(`/zones/${zoneId}/workers/routes`, { method: 'POST', body: JSON.stringify({ pattern, script: scriptName }) }).catch(error => { throw scopeError(error, 'Workers Routes: Edit (zone level)') })
    return 'route'
  }

  /**
   * Setup only finishes when the gateway answers for an unpublished hostname:
   * that response proves the script is live, the wildcard binding routes to it,
   * and the certificate covers the address. Cloudflare needs a moment to
   * propagate, so this retries instead of failing on the first attempt.
   */
  async #probe(baseDomain: string) {
    const url = `https://shun-sites-check-${randomBytes(4).toString('hex')}.${baseDomain}/`
    let last = 'no response'
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const response = await this.#fetchUrl(url, { redirect: 'manual' })
        if (response.headers.get('x-shun-sites') === 'gateway') return { ok: true, message: '' }
        last = `status ${response.status} without the gateway marker`
      } catch (error) { last = error instanceof Error ? error.message : String(error) }
      await new Promise(resolve => setTimeout(resolve, attempt < 2 ? 1_500 : 3_000))
    }
    return { ok: false, message: last }
  }

  async #verifyUrl(url: string) {
    try {
      const response = await this.#fetchUrl(url, { redirect: 'manual', headers: { 'cache-control': 'no-cache' } })
      return response.status === 200 || response.status === 401
    } catch { return false }
  }

  async #kvValue(config: SitesConfig, key: string): Promise<unknown> {
    const path = `/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(key)}`
    try {
      const raw = await this.#api.request(path, { headers: { accept: 'application/json' } })
      if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return raw } }
      return raw
    } catch (error) {
      // A missing key is an ordinary answer here: it is how a first publish and
      // a deleted site both look. Anything else is a real failure.
      if (error instanceof Error && /Cloudflare API 404/.test(error.message)) return undefined
      throw error
    }
  }

  async #kvJson<T>(config: SitesConfig, key: string): Promise<T | undefined> {
    const value = await this.#kvValue(config, key)
    return value === undefined ? undefined : value as T
  }

  async #kvPut(config: SitesConfig, key: string, value: string) {
    await this.#api.request(`/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: value,
    })
  }

  async #kvDelete(config: SitesConfig, key: string) {
    await this.#api.request(`/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(key)}`, { method: 'DELETE' })
  }

  /** Asset bytes and the hash the gateway serves as its ETag travel in one write. */
  async #kvBulkPut(config: SitesConfig, entries: Array<{ key: string, value: Buffer, metadata: Record<string, unknown> }>) {
    const path = `/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/bulk`
    let body: Array<{ key: string, value: string, base64: true, metadata: Record<string, unknown> }> = []
    let bytes = 0
    for (const entry of entries) {
      const encoded = entry.value.toString('base64')
      body.push({ key: entry.key, value: encoded, base64: true, metadata: entry.metadata })
      bytes += encoded.length
      if (body.length >= kvWriteChunk || bytes >= kvWriteChunkBytes) {
        await this.#api.request(path, { method: 'PUT', body: JSON.stringify(body) })
        body = []
        bytes = 0
      }
    }
    if (body.length) await this.#api.request(path, { method: 'PUT', body: JSON.stringify(body) })
  }

  async #kvBulkDelete(config: SitesConfig, keys: string[]) {
    if (!keys.length) return
    await this.#api.request(`/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/bulk`, { method: 'DELETE', body: JSON.stringify(keys) })
  }

  /**
   * HTML is served must-revalidate, so a republish is visible without a purge.
   * These purges only shorten the wait for changed assets, and a purge failure
   * must never fail a publish that already stored the bytes.
   */
  async #purge(config: SitesConfig, urls: string[]) {
    for (let index = 0; index < urls.length; index += purgeChunk) {
      await this.#api.request(`/zones/${config.zoneId}/purge_cache`, { method: 'POST', body: JSON.stringify({ files: urls.slice(index, index + purgeChunk) }) }).catch(() => undefined)
    }
  }

  async #writeConfig(config: SitesConfig) {
    await mkdir(dirname(this.#configFile), { recursive: true })
    const staging = `${this.#configFile}.tmp`
    await writeFile(staging, JSON.stringify({ version: 1, config } satisfies StoredConfig, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(staging, this.#configFile)
  }
}

export function normalizeVisibility(value: unknown): SiteVisibility | undefined {
  const text = String(value || '').trim().toLowerCase()
  return text === 'public' || text === 'password' || text === 'off' ? text as SiteVisibility : undefined
}

export function slugify(value: string) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site'
}

export function normalizeSlug(value: unknown) {
  const slug = slugify(String(value || ''))
  if (slug.length < 3) throw Error('A site name needs at least three characters.')
  if (reservedSlugs.has(slug)) throw Error(`"${slug}" is reserved. Choose another site name.`)
  return slug
}

export function contentType(path: string) {
  const extension = path.split('.').pop()?.toLowerCase() || ''
  return contentTypes[extension] || 'application/octet-stream'
}

export function publicSite(record: PublishedSite): PublishedSite {
  const { slug, title, host, url, visibility, files, bytes, publishedAt, revision } = record
  return { slug, title, host, url, visibility, files, bytes, publishedAt, revision }
}

/**
 * A site answers one level below `baseDomain`, so the free certificate only
 * covers the case where that domain is the zone itself.
 */
function certificateWarning(config: SitesConfig) {
  return `Sites would answer at <name>.${config.baseDomain}, which is two levels below ${config.zoneName} and outside the free Universal SSL certificate. Publish under ${config.zoneName} directly, or add an advanced certificate.`
}

/**
 * Readable enough to retype from a chat message, long enough to matter: no
 * look-alike characters, and grouped so it survives being copied by hand.
 */
function generatedPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  return [...randomBytes(20)].map(byte => alphabet[byte % alphabet.length]).join('').replace(/(.{5})(?=.)/g, '$1-')
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

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

async function hasIndex(directory: string) {
  return stat(join(directory, 'index.html')).then(info => info.isFile(), () => false)
}

function cloudflareId(value: unknown, label: string) {
  const id = String(value || '').trim()
  if (!/^[A-Fa-f0-9]{32}$/.test(id)) throw Error(`Enter a valid 32-character Cloudflare ${label} ID.`)
  return id
}

/**
 * A refused Cloudflare write is almost always a token that lacks one exact
 * scope. Naming it turns "Authentication error" into a fix the user can make.
 */
function scopeError(error: unknown, scope: string) {
  const message = error instanceof Error ? error.message : String(error)
  if (!/Cloudflare API (?:401|403)/.test(message)) return error instanceof Error ? error : Error(message)
  return Error(`${scope} is required on the Cloudflare token: ${message}`)
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return { ...fallback, ...JSON.parse(await readFile(file, 'utf8')) as T } } catch { return fallback }
}
