/**
 * The published-site API.
 *
 * A client authenticates with a device key it generated for itself, sends only
 * what changed, and gets back the address its site answers at. Everything else —
 * which namespace, which account, how a file is stored, how a password is kept —
 * is decided here and never leaves.
 */
import { parsePublisherAuthorization, verifyPublisherSignature } from '../../registry/src/publishers.ts'

export const apiHost = 'sites-api.shunagent.site'

/** Every published site lives under this domain. The client is told, never asked. */
const domain = 'shunagent.site'

const maxFiles = 5_000
const maxFileBytes = 25 * 1024 * 1024
const maxTotalBytes = 200 * 1024 * 1024
const maxSitesPerPublisher = 25
const maxSites = 2_000
const contentTypes = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', pdf: 'application/pdf', wasm: 'application/wasm', mp4: 'video/mp4', webm: 'video/webm',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', csv: 'text/csv; charset=utf-8', webmanifest: 'application/manifest+json',
  zip: 'application/zip',
}
/** Names the service keeps for itself, plus the ones any DNS owner would expect. */
const reservedNames = new Set(['www', 'api', 'sites-api', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'cdn', 'admin', 'root', 'ns', 'ns1', 'ns2', 'dns', 'mx', 'status', 'support', 'help', 'docs', 'blog', 'shop', 'dev', 'staging', 'test', 'localhost', 'assets', 'static', 'edge', 'workers', 'pages', 'registry', 'updates', 'release', 'internal', 'health', 'gateway', 'sites'])

export async function handleApi(request, env, now = Date.now) {
  try {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const method = request.method
    const device = await authorize(request, env, now)
    if (!device) return json({ error: 'This client is not allowed to publish.' }, 401)

    if (!path.startsWith('/__api/')) return json({ error: 'Unknown request.' }, 404)

    if (path === '/__api/state' && method === 'GET') {
      const sites = (await Promise.all((await deviceSites(env, device)).map(name => siteRecord(env, name)))).filter(Boolean)
      return json({ domain, sites: sites.map(site => publicSite(site)) })
    }

    if (path === '/__api/resolve' && method === 'POST') {
      const body = await readJson(request)
      const project = projectOf(body)
      const explicit = body.name === undefined ? '' : suggestedName(body.name)
      const name = await resolveName(env, device, project, explicit, suggestedName(body.suggest), body.takeOver === true)
      const record = await siteRecord(env, name)
      return json({
        domain, name, url: urlFor(name), visibility: record?.visibility || 'public',
        manifest: await manifestOf(env, name),
      })
    }

    const assets = path.match(/^\/__api\/sites\/([a-z0-9-]{1,40})\/assets$/)
    if (assets && method === 'PUT') {
      const body = await readJson(request)
      // The same takeover that the publish allows must cover its upload, or a
      // deliberate replacement is refused by the step before it.
      const name = await ownedSite(env, assets[1], projectOf(body), body.takeOver === true)
      return json(await writeAssets(env, name, Array.isArray(body.files) ? body.files : []))
    }

    const visibility = path.match(/^\/__api\/sites\/([a-z0-9-]{1,40})\/visibility$/)
    if (visibility && method === 'POST') {
      const body = await readJson(request)
      const name = await deviceSite(env, device, visibility[1])
      const mode = normalizeVisibility(body.visibility)
      if (!mode) throw httpError('Choose public, password, or off.', 400)
      const record = await siteRecord(env, name)
      if (!record) throw httpError(`${name}.${domain} is not published.`, 404)
      const secret = await secretFor(mode, typeof body.password === 'string' ? body.password : '', record)
      const updated = { ...record, visibility: mode, ...secret.stored, revision: (record.revision || 0) + 1 }
      await writeSite(env, updated)
      return json({ site: publicSite(updated), ...(secret.issued ? { password: secret.issued } : {}) })
    }

    const site = path.match(/^\/__api\/sites\/([a-z0-9-]{1,40})$/)
    if (site && method === 'POST') {
      const body = await readJson(request)
      return json(await publish(env, device, await ownedSite(env, site[1], projectOf(body), body.takeOver === true), body))
    }
    // Taking a site down says which site and nothing else: the device owns it.
    if (site && method === 'DELETE') return json(await removeSite(env, device, await deviceSite(env, device, site[1])))

    return json({ error: 'Unknown request.' }, 404)
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, statusOf(error))
  }
}

/**
 * Publishing is authorized by the identity the marketplace already verifies: a
 * confirmed email address and a device key that signs this exact request. There
 * is no account to create and no key this service hands out — an unknown or
 * revoked device cannot publish, and the same identity covers plugins and sites.
 */
async function authorize(request, env) {
  const auth = parsePublisherAuthorization(request.headers.get('authorization'))
  if (!auth) throw httpError('Publishing needs a verified email address. Verify one, then publish again.', 401)
  const body = new Uint8Array(await request.clone().arrayBuffer())
  const result = await verifyPublisherSignature(env.DB, auth, { method: request.method, path: new URL(request.url).pathname, body })
  if (result.ok) return { handle: result.handle, deviceId: result.deviceId }
  throw httpError(result.error === 'stale_signature'
    ? 'The request signature expired. Try again.'
    : 'This device is not authorized to publish. Verify the email address again, then publish.', 401)
}

async function deviceSites(env, device) {
  const record = await env.SITES.get(`p:${device.handle}`, { type: 'json' })
  return Array.isArray(record?.sites) ? record.sites.filter(name => typeof name === 'string') : []
}

async function claimSite(env, device, name) {
  const record = (await env.SITES.get(`p:${device.handle}`, { type: 'json' })) || { sites: [] }
  if (record.sites.includes(name)) return
  if (record.sites.length >= maxSitesPerPublisher) throw httpError(`This publisher has ${maxSitesPerPublisher} sites. Take one down before publishing another.`, 409)
  await env.SITES.put(`p:${device.handle}`, JSON.stringify({ ...record, sites: [...record.sites, name] }))
}

/**
 * The address is assigned here, so every client behaves the same and a clash is
 * never a question: the project keeps the address it already has, and otherwise
 * takes its own name or the next free variant.
 */
async function resolveName(env, device, project, asked, suggested, takeOver) {
  const mine = []
  for (const name of await deviceSites(env, device)) {
    const record = await siteRecord(env, name)
    if (record?.project === project) mine.push(name)
  }
  // An address the person asked for by name outranks the one the project has,
  // unless the service keeps that name for itself.
  if (asked && !reservedNames.has(asked)) {
    const existing = await siteRecord(env, asked)
    if (!existing || existing.project === project || takeOver) return asked
  }
  if (mine.length) return mine[0]
  const base = (asked || suggested || 'site').slice(0, 36)
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`
    const taken = await siteRecord(env, candidate)
    if (taken) {
      if (taken.project === project || (takeOver && candidate === base)) return candidate
      continue
    }
    if (reservedNames.has(candidate)) continue
    return candidate
  }
  throw httpError(`No free address is available for ${base}.${domain}.`, 409)
}

async function publish(env, device, name, body) {
  const manifest = normalizeManifest(body.manifest)
  if (!manifest['index.html']) throw httpError('A published site needs an index.html at its root.', 400)
  const files = Object.keys(manifest).length
  const bytes = Object.values(manifest).reduce((total, file) => total + file.size, 0)
  if (files > maxFiles) throw httpError(`This site has more than ${maxFiles} files.`, 413)
  if (bytes > maxTotalBytes) throw httpError('This site is larger than one publish can carry.', 413)

  const previous = await manifestOf(env, name)
  const removed = Object.keys(previous).filter(path => !manifest[path])
  await deleteKeys(env, removed.map(path => `a:${name}/${path}`))

  const existing = await siteRecord(env, name)
  const mode = normalizeVisibility(body.visibility) || existing?.visibility || 'public'
  const secret = await secretFor(mode, typeof body.password === 'string' ? body.password : '', existing)
  const record = {
    name,
    title: String(body.title || existing?.title || name).trim().slice(0, 120) || name,
    host: `${name}.${domain}`,
    visibility: mode,
    files,
    bytes,
    revision: (existing?.revision || 0) + 1,
    publishedAt: Date.now(),
    publisher: device.handle,
    project: projectOf(body),
    ...secret.stored,
  }
  const index = await env.SITES.get('index', { type: 'json' })
  const names = Array.isArray(index) ? index : []
  if (!names.includes(name) && names.length >= maxSites) throw httpError('The publishing service is at capacity. Try again later.', 503)
  await env.SITES.put(`f:${name}`, JSON.stringify(manifest))
  await writeSite(env, record)
  if (!names.includes(name)) await env.SITES.put('index', JSON.stringify([...names, name].sort()))
  await claimSite(env, device, name)
  return { site: publicSite(record), uploaded: files, removed: removed.length, ...(secret.issued ? { password: secret.issued } : {}) }
}

async function removeSite(env, device, name) {
  const manifest = await manifestOf(env, name)
  const paths = Object.keys(manifest).map(path => `a:${name}/${path}`)
  await deleteKeys(env, paths)
  await env.SITES.delete(`f:${name}`)
  await env.SITES.delete(`s:${name}`)
  await env.SITES.delete(`h:${name}.${domain}`)
  const index = await env.SITES.get('index', { type: 'json' })
  await env.SITES.put('index', JSON.stringify((Array.isArray(index) ? index : []).filter(item => item !== name)))
  const record = (await env.SITES.get(`p:${device.handle}`, { type: 'json' })) || { sites: [] }
  await env.SITES.put(`p:${device.handle}`, JSON.stringify({ ...record, sites: record.sites.filter(item => item !== name) }))
  return { name, removed: paths.length }
}

/** Files arrive as base64 because the request body is JSON, and are stored as bytes. */
async function writeAssets(env, name, files) {
  let stored = 0, bytes = 0
  for (const file of files) {
    const path = normalizePath(file?.path)
    const data = typeof file?.base64 === 'string' ? file.base64 : ''
    if (!path || !data) throw httpError('A file entry was not usable.', 400)
    const value = decodeBase64(data)
    if (value.byteLength > maxFileBytes) throw httpError(`${path} is larger than the 25 MiB one file may be.`, 413)
    bytes += value.byteLength
    await env.SITES.put(`a:${name}/${path}`, value, { metadata: { sha256: String(file.hash || ''), type: contentType(path) } })
    stored++
  }
  return { stored, bytes }
}

/** A site this device published; the client manages its own sites without naming a project. */
async function deviceSite(env, device, name) {
  if (!(await deviceSites(env, device)).includes(name)) throw httpError(`${name}.${domain} is not one of this client's sites.`, 404)
  return name
}

async function ownedSite(env, name, project, takeOver = false) {
  if (reservedNames.has(name)) throw httpError(`${name}.${domain} is kept for the service itself.`, 409)
  const record = await siteRecord(env, name)
  if (record && record.project !== project && !takeOver) throw httpError(`${name}.${domain} belongs to another project.`, 409)
  return name
}

async function secretFor(mode, provided, existing) {
  // Explicitly cleared, so a site that goes public or paused keeps no password
  // hash, and protection enabled later is a new password rather than an old one
  // nobody remembers.
  if (mode !== 'password') return { stored: { salt: undefined, hash: undefined } }
  const password = provided.trim()
  if (!password) {
    if (existing?.hash) return { stored: { salt: existing.salt, hash: existing.hash } }
    const issued = generatedPassword()
    const salt = randomHex(16)
    return { stored: { salt, hash: await sha256(`${salt}${issued}`) }, issued }
  }
  if (password.length < 4 || password.length > 200) throw httpError('Choose a password of 4 to 200 characters.', 400)
  const salt = existing?.salt || randomHex(16)
  return { stored: { salt, hash: await sha256(`${salt}${password}`) } }
}

async function writeSite(env, record) {
  await env.SITES.put(`s:${record.name}`, JSON.stringify(record))
  await env.SITES.put(`h:${record.host}`, JSON.stringify({
    slug: record.name, title: record.title, visibility: record.visibility,
    ...(record.salt ? { salt: record.salt } : {}), ...(record.hash ? { hash: record.hash } : {}),
  }))
}

function siteRecord(env, name) {
  return env.SITES.get(`s:${name}`, { type: 'json' })
}

async function manifestOf(env, name) {
  const manifest = await env.SITES.get(`f:${name}`, { type: 'json' })
  return manifest && typeof manifest === 'object' && !Array.isArray(manifest) ? manifest : {}
}

async function deleteKeys(env, keys) {
  for (const key of keys) await env.SITES.delete(key)
}

function publicSite(record) {
  return {
    name: record.name, title: record.title, url: urlFor(record.name), visibility: record.visibility,
    files: record.files, bytes: record.bytes, publishedAt: record.publishedAt, revision: record.revision,
  }
}

const urlFor = name => `https://${name}.${domain}/`

function projectOf(body) {
  const project = String(body?.project || '').trim()
  if (!/^[a-f0-9]{16,64}$/.test(project)) throw httpError('The request did not identify its project.', 400)
  return project
}

/** The name a project would like, sanitized. Conflicts are resolved, never reported. */
export function suggestedName(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36)
}

function normalizePath(value) {
  const path = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!path || path.length > 400 || path.split('/').some(part => part === '..' || part === '.' || part === '')) return ''
  return path
}

function normalizeManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('The publish did not include a file manifest.', 400)
  const manifest = {}
  for (const [rawPath, file] of Object.entries(value)) {
    const path = normalizePath(rawPath)
    if (!path) continue
    manifest[path] = { hash: String(file?.hash || ''), size: Number(file?.size) || 0 }
  }
  return manifest
}

function normalizeVisibility(value) {
  const mode = String(value || '').trim().toLowerCase()
  return mode === 'public' || mode === 'password' || mode === 'off' ? mode : undefined
}

function contentType(path) {
  return contentTypes[path.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream'
}

function decodeBase64(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function generatedPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  return [...crypto.getRandomValues(new Uint8Array(20))].map(byte => alphabet[byte % alphabet.length]).join('').replace(/(.{5})(?=.)/g, '$1-')
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function readJson(request) {
  try {
    const value = await request.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('bad body')
    return value
  } catch { throw httpError('The request body was not usable.', 400) }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

function httpError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

function statusOf(error) {
  return typeof error?.status === 'number' ? error.status : 500
}
