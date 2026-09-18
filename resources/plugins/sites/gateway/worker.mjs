/**
 * Shun Sites gateway.
 *
 * This Worker is the only public surface of a published site, and it is
 * read-only: it holds no secret, accepts no upload, and can change no stored
 * state. Everything a publish writes — the host map, the site record, the
 * asset bytes — is written from the Shun desktop app through the Cloudflare
 * API with the account owner's own token. A leaked gateway therefore leaks
 * what is already public.
 *
 * It is uploaded, with its KV binding, by `site-publishing.ts` during setup.
 * Keep it dependency-free: the module is uploaded verbatim, never bundled.
 */

const CACHE_TTL = 30
const AUTH_COOKIE = '__shun_site'
const HEALTH_HEADER = { 'x-shun-sites': 'gateway' }

/** Per-isolate memo of the host map. `cacheTtl` bounds staleness inside KV itself. */
const hostMemo = new Map()

const contentTypes = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', eot: 'application/vnd.ms-fontobject', pdf: 'application/pdf', wasm: 'application/wasm',
  mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', csv: 'text/csv; charset=utf-8',
  webmanifest: 'application/manifest+json', zip: 'application/zip',
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const host = url.hostname.toLowerCase()
    const record = await hostRecord(env, host)
    if (!record) return notHosted()

    if (record.visibility === 'off') return text(503, 'This site is paused.')
    if (record.visibility === 'password') {
      const authorized = await hasAccess(request, record)
      if (!authorized) return passwordGate(request, record)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Method not allowed.')

    return await asset(request, env, record, url)
  },
}

async function hostRecord(env, host) {
  const memoized = hostMemo.get(host)
  if (memoized && memoized.expiresAt > Date.now()) return memoized.value
  const value = await env.SITES.get(`h:${host}`, { type: 'json', cacheTtl: CACHE_TTL })
  hostMemo.set(host, { value, expiresAt: Date.now() + CACHE_TTL * 1000 })
  return value
}

async function asset(request, env, record, url) {
  const requested = decodePath(url.pathname)
  if (requested === null) return text(404, 'Not found.')
  for (const candidate of candidates(requested)) {
    const found = await env.SITES.getWithMetadata(`a:${record.slug}/${candidate}`, { type: 'arrayBuffer', cacheTtl: CACHE_TTL })
    if (!found || found.value === null) continue
    return response(request, found.value, candidate, found.metadata, candidate === '404.html' ? 404 : 200)
  }
  return text(404, 'Not found.')
}

/** `/a/b/` and `/a/b` both mean the directory index; nothing else is rewritten. */
function candidates(path) {
  if (!path) return ['index.html']
  if (path.endsWith('/')) return [`${path}index.html`, '404.html']
  return [path, `${path}/index.html`, '404.html']
}

function decodePath(pathname) {
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  if (decoded.includes('\u0000')) return null
  const parts = decoded.split('/').filter(Boolean)
  if (parts.some(part => part === '..' || part === '.')) return null
  return parts.join('/')
}

function response(request, body, path, metadata, status) {
  const extension = path.split('.').pop()?.toLowerCase() || ''
  const headers = new Headers(HEALTH_HEADER)
  headers.set('content-type', metadata?.type || contentTypes[extension] || 'application/octet-stream')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('referrer-policy', 'strict-origin-when-cross-origin')
  headers.set('cache-control', status === 404 || extension === 'html' || extension === 'htm'
    ? 'public, max-age=0, must-revalidate'
    : 'public, max-age=300')
  const etag = metadata?.sha256 ? `"${metadata.sha256}"` : ''
  if (etag) {
    headers.set('etag', etag)
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  }
  return new Response(request.method === 'HEAD' ? null : body, { status, headers })
}

function hasAccess(request, record) {
  if (!record.hash) return false
  const cookies = request.headers.get('cookie') || ''
  const value = cookies.split(';').map(part => part.trim()).find(part => part.startsWith(`${AUTH_COOKIE}=`))?.slice(AUTH_COOKIE.length + 1)
  if (!value) return false
  return value === record.hash
}

async function passwordGate(request, record) {
  if (request.method === 'POST') {
    // The form posts to the same path; a wrong password re-renders the gate
    // instead of redirecting, so the browser never shows a blank POST result.
    const form = await request.formData().catch(() => null)
    const provided = String(form?.get('password') || '')
    const hash = provided ? await sha256(`${record.salt || ''}${provided}`) : ''
    if (hash && hash === record.hash) {
      const headers = new Headers({ location: new URL(request.url).pathname || '/', 'set-cookie': `${AUTH_COOKIE}=${hash}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`, ...HEALTH_HEADER })
      return new Response(null, { status: 303, headers })
    }
    return page(401, passwordPage(record, 'That password is not correct.'))
  }
  return page(401, passwordPage(record, ''))
}

function passwordPage(record, error) {
  const title = escapeHtml(record.title || record.slug || 'Site')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Password required</title>
<style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#111315;color:#e9ebee;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
form{width:min(320px,86vw);display:grid;gap:10px;padding:22px;border:1px solid #ffffff1b;border-radius:12px;background:#191b1e}
h1{margin:0;font-size:14px;font-weight:600}p{margin:0;color:#959ba4;font-size:12px}
input{height:34px;padding:0 10px;border:1px solid #ffffff1b;border-radius:8px;background:#111315;color:#e9ebee;font:inherit}
button{height:34px;border:0;border-radius:8px;background:#5d9fe8;color:#0d1117;font:inherit;font-weight:600;cursor:pointer}
.error{color:#e0a0a0}</style></head><body><form method="post"><h1>${title}</h1><p>This site is password protected.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}<input type="password" name="password" autocomplete="current-password" autofocus required><button type="submit">Continue</button></form></body></html>`
}

function notHosted() {
  return page(404, '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Not found</title></head><body style="margin:0;display:grid;place-items:center;height:100%;background:#111315;color:#959ba4;font:14px -apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif">Nothing is published at this address.</body></html>')
}

function page(status, body) {
  return new Response(body, { status, headers: { ...HEALTH_HEADER, 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' } })
}

function text(status, body) {
  return new Response(body, { status, headers: { ...HEALTH_HEADER, 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } })
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}
