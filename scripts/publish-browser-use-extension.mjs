#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Publish Shun Browser Use to the Chrome Web Store through the store's own API.
 *
 * The dashboard cannot be driven: Chrome refuses to let an extension inspect the Web
 * Store origin, and the console is a client-side application whose item rows are not
 * links, not in the tab order, and do not respond to synthesized clicks. The API is
 * the supported path, and this is it, following the flow the Chrome Web Store API
 * guide documents: refresh an access token, upload the package, publish the item.
 *
 *   node scripts/publish-browser-use-extension.mjs --authorize   # once: consent, stores a refresh token
 *   node scripts/publish-browser-use-extension.mjs              # package, upload, publish
 *   node scripts/publish-browser-use-extension.mjs --status     # what the store currently holds
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = join(root, '.env.release')
const packagePath = join(root, 'docs', 'browser-use-store', 'Shun-Browser-Use-store.zip')
const itemId = 'nlgfkakigbblngkkfbjjcnelmnnacbnb'
const scope = 'https://www.googleapis.com/auth/chromewebstore'
const uploadEndpoint = 'https://chromewebstore.googleapis.com/upload/v2'
const apiEndpoint = 'https://chromewebstore.googleapis.com/v2'
const tokenEndpoint = 'https://oauth2.googleapis.com/token'

function readEnvironment() {
  const values = new Map()
  if (!existsSync(envPath)) return values
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match) values.set(match[1], match[2])
  }
  return values
}

const environment = readEnvironment()
const value = name => (process.env[name] || environment.get(name) || '').trim()
const clientId = value('CHROME_WEBSTORE_CLIENT_ID') || value('SHUN_GOOGLE_OAUTH_CLIENT_ID')
const clientSecret = value('CHROME_WEBSTORE_CLIENT_SECRET') || value('SHUN_GOOGLE_OAUTH_CLIENT_SECRET')
const refreshToken = value('CHROME_WEBSTORE_REFRESH_TOKEN')
const publisherId = value('CHROME_WEBSTORE_PUBLISHER_ID')

function fail(message) {
  console.error(message)
  process.exit(1)
}

/**
 * The consent step is the account holder's: this opens the page where they approve
 * access, and the token that comes back is written to their release environment.
 */
async function authorize() {
  if (!clientId || !clientSecret) fail('CHROME_WEBSTORE_CLIENT_ID and CHROME_WEBSTORE_CLIENT_SECRET (or the SHUN_GOOGLE_OAUTH_* pair) are required in .env.release.')
  const server = createServer()
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  const port = server.address().port
  const redirect = `http://127.0.0.1:${port}`
  const consent = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  consent.searchParams.set('client_id', clientId)
  consent.searchParams.set('redirect_uri', redirect)
  consent.searchParams.set('response_type', 'code')
  consent.searchParams.set('scope', scope)
  consent.searchParams.set('access_type', 'offline')
  consent.searchParams.set('prompt', 'consent')

  console.log('Open this in Chrome and approve access; nothing else is needed from you:')
  console.log(`\n  ${consent.toString()}\n`)
  spawnSync('/usr/bin/open', [consent.toString()])

  const code = await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('Timed out waiting for the approval after 5 minutes.')), 5 * 60 * 1000)
    server.on('request', (request, response) => {
      const url = new URL(request.url, redirect)
      const value = url.searchParams.get('code')
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(value ? 'Shun is authorized. You can close this tab.' : 'No authorization code arrived.')
      if (value) { clearTimeout(timer); resolvePromise(value) }
    })
  }).finally(() => server.close())

  const tokens = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
  }).then(response => response.json())
  if (!tokens.refresh_token) fail(`Google did not return a refresh token: ${JSON.stringify(tokens).slice(0, 300)}`)

  const lines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n').filter(line => !/^CHROME_WEBSTORE_REFRESH_TOKEN=/.test(line.trim())) : []
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  lines.push(`CHROME_WEBSTORE_REFRESH_TOKEN=${tokens.refresh_token}`, '')
  writeFileSync(envPath, lines.join('\n'), { mode: 0o600 })
  console.log(`Authorized. The refresh token is stored in ${envPath}.`)
}

async function accessToken() {
  if (!clientId || !clientSecret || !refreshToken) fail('CHROME_WEBSTORE_CLIENT_ID, CHROME_WEBSTORE_CLIENT_SECRET and CHROME_WEBSTORE_REFRESH_TOKEN are required in .env.release. Run --authorize once first.')
  const tokens = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  }).then(response => response.json())
  if (!tokens.access_token) fail(`Google refused the refresh token: ${JSON.stringify(tokens).slice(0, 300)}`)
  return tokens.access_token
}

async function authenticated(path, init = {}) {
  if (!publisherId) fail('CHROME_WEBSTORE_PUBLISHER_ID is required in .env.release (Publisher > Settings in the developer dashboard).')
  const token = await accessToken()
  return fetch(path, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` } })
}

async function status() {
  const response = await authenticated(`${apiEndpoint}/publishers/${publisherId}/items/${itemId}:fetchStatus`)
  const body = await response.json()
  console.log(JSON.stringify(body, null, 2))
  return response.ok
}

async function publish() {
  // The store refuses a package whose version is not newer than the one it holds, so
  // the package is always rebuilt from the current source before it is uploaded.
  const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-browser-use-store-package.mjs'), packagePath], { encoding: 'utf8' })
  if (built.status !== 0) fail(built.stderr?.trim() || 'Could not build the store package.')
  console.log(built.stdout.trim())
  const bytes = readFileSync(packagePath)
  console.log(`package: ${packagePath} · ${bytes.length} bytes · sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}…`)

  const upload = await authenticated(`${uploadEndpoint}/publishers/${publisherId}/items/${itemId}:upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: bytes,
  })
  const uploaded = await upload.json()
  console.log(`upload: ${upload.status} ${JSON.stringify(uploaded)}`)
  if (!upload.ok) fail('The store refused the package.')

  // The reference for this endpoint documents the body and, more usefully, that validation
  // warnings come back in the response for inspection: `blockOnWarnings` decides whether they
  // fail the request, and a refusal carries the reason in error.details either way.
  const released = await authenticated(`${apiEndpoint}/publishers/${publisherId}/items/${itemId}:publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH', blockOnWarnings: false }),
  })
  const published = await released.json()
  console.log(`publish: ${released.status} ${JSON.stringify(published, null, 2)}`)
  if (!released.ok) {
    const details = published?.error?.details || []
    for (const detail of details) if (detail?.metadata) console.log(`detail: ${JSON.stringify(detail.metadata)}`)
    fail('The store refused the publish request.')
  }
  for (const warning of published?.warningInfo?.warnings || []) console.log(`warning: ${warning.reason} — ${warning.description}`)
  console.log('Submitted for review. The listing updates when the review passes.')
}

if (process.argv.includes('--authorize')) await authorize()
else if (process.argv.includes('--status')) process.exitCode = await status() ? 0 : 1
else await publish()
