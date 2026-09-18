import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import service from '../src/index.mjs'
import { apiHost, base64, call, database, environment, json, storedJson, storedText, verifiedIdentity } from './helpers.mjs'

const project = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const otherProject = '0f1e2d3c4b5a69788796a5b4c3d2e1f0'

/** A publisher with a verified identity, plus any other identity that must verify. */
async function setup(extra = []) {
  const publisher = await verifiedIdentity()
  const devices = [publisher, ...extra]
  return {
    publisher,
    env: environment(devices.map(device => ({ id: device.deviceId, handle: device.handle, publicKey: device.publicKey }))),
    devices,
    use(...identities) {
      return environment([...devices, ...identities].map(device => ({ id: device.deviceId, handle: device.handle, publicKey: device.publicKey })))
    },
  }
}

async function publish(env, identity, name, { files = {}, project: owner = project, visibility, takeOver } = {}) {
  const entries = Object.entries(files)
  if (entries.length) {
    await call(env, identity, `/__api/sites/${name}/assets`, {
      method: 'PUT',
      body: { project: owner, files: entries.map(([path, text]) => ({ path, hash: `h-${path}`, base64: base64(text) })) },
    })
  }
  return json(await call(env, identity, `/__api/sites/${name}`, {
    body: {
      project: owner, visibility, takeOver,
      manifest: Object.fromEntries(entries.map(([path, text]) => [path, { hash: `h-${path}`, size: text.length }])),
    },
  }))
}

const resolve = (env, identity, body) => call(env, identity, '/__api/resolve', { body }).then(json)

test('publishing is refused without a verified device signature', async () => {
  const { publisher, env } = await setup()
  assert.equal((await json(await call(env, publisher, '/__api/resolve', { body: { project, name: 'demo' }, anonymous: true }))).status, 401)

  // A signature over different bytes is refused, because the signature covers them.
  const forged = await publisher.authorization('POST', '/__api/resolve', new TextEncoder().encode('{"project":"other"}'))
  const request = new Request(`https://${apiHost}/__api/resolve`, {
    method: 'POST', headers: { authorization: forged, 'content-type': 'application/json' }, body: JSON.stringify({ project, name: 'demo' }),
  })
  assert.equal((await service.fetch(request, env)).status, 401)

  // So is one that has aged out of the window.
  const aged = (await publisher.authorization('POST', '/__api/resolve', new TextEncoder().encode(JSON.stringify({ project, name: 'demo' })))).replace(/timestamp=\d+/, `timestamp=${Date.now() - 10 * 60 * 1000}`)
  const stale = new Request(`https://${apiHost}/__api/resolve`, {
    method: 'POST', headers: { authorization: aged, 'content-type': 'application/json' }, body: JSON.stringify({ project, name: 'demo' }),
  })
  assert.equal((await service.fetch(stale, env)).status, 401)

  // A revoked device is not authorized either.
  const revoked = await verifiedIdentity('revoked')
  const revokedEnv = { SITES: environment([]).SITES, DB: database([{ id: revoked.deviceId, handle: revoked.handle, publicKey: revoked.publicKey, revokedAt: new Date().toISOString() }]) }
  assert.equal((await resolve(revokedEnv, revoked, { project, name: 'demo' })).status, 401)
})

test('the service assigns an address, keeps the project’s own, and moves on a clash', async () => {
  const { publisher, env } = await setup()
  assert.deepEqual((await resolve(env, publisher, { project, name: 'My Portfolio' })).body.name, 'my-portfolio')
  await publish(env, publisher, 'my-portfolio', { files: { 'index.html': 'mine' } })

  // A suggestion never moves a project that already has an address; an address
  // asked for by name does.
  assert.equal((await resolve(env, publisher, { project, suggest: 'anything-else' })).body.name, 'my-portfolio')
  assert.equal((await resolve(env, publisher, { project, name: 'chosen' })).body.name, 'chosen')
  const first = await resolve(env, publisher, { project, suggest: 'my-portfolio' })
  assert.deepEqual({ url: first.body.url, domain: first.body.domain }, { url: 'https://my-portfolio.shunagent.site/', domain: 'shunagent.site' })

  // Another project takes the next free variant, and names the service keeps are skipped.
  assert.equal((await resolve(env, publisher, { project: otherProject, name: 'my-portfolio' })).body.name, 'my-portfolio-2')
  assert.equal((await resolve(env, publisher, { project: otherProject, name: 'www' })).body.name, 'www-2')
  assert.equal((await resolve(env, publisher, { project: otherProject, name: 'sites-api' })).body.name, 'sites-api-2')
})

test('publishing stores the files, the record, the owner, and the index, and needs a root', async () => {
  const { publisher, env } = await setup()
  const published = await publish(env, publisher, 'demo', { files: { 'index.html': '<h1>hi</h1>', 'a/b.js': 'x' } })
  assert.equal(published.status, 200)
  assert.equal(published.body.site.url, 'https://demo.shunagent.site/')
  assert.equal(storedText(env, 'a:demo/index.html'), '<h1>hi</h1>')
  assert.equal(storedJson(env, 's:demo').publisher, 'kyle')
  assert.equal(storedJson(env, 'h:demo.shunagent.site').slug, 'demo')
  assert.deepEqual(storedJson(env, 'index'), ['demo'])
  assert.deepEqual(storedJson(env, 'p:kyle').sites, ['demo'])

  assert.equal((await publish(env, publisher, 'demo', { files: { 'about.html': 'no root' } })).status, 400)

  // Republishing without a file removes it.
  const trimmed = await publish(env, publisher, 'demo', { files: { 'index.html': '<h1>hi</h1>' } })
  assert.equal(trimmed.body.removed, 1)
  assert.equal(env.SITES.records.has('a:demo/a/b.js'), false)
})

test('an address belongs to the project that published it', async () => {
  const { publisher, env } = await setup()
  await publish(env, publisher, 'demo', { files: { 'index.html': 'mine' } })
  const stolen = await publish(env, publisher, 'demo', { files: { 'index.html': 'theirs' }, project: otherProject })
  assert.equal(stolen.status, 409)
  assert.equal(storedText(env, 'a:demo/index.html'), 'mine')

  const taken = await publish(env, publisher, 'demo', { files: { 'index.html': 'theirs' }, project: otherProject, takeOver: true })
  assert.equal(taken.status, 200)
  assert.equal(storedJson(env, 's:demo').project, otherProject)
})

test('protection is issued once, kept salted, and cleared when the site goes public', async () => {
  const { publisher, env } = await setup()
  await publish(env, publisher, 'demo', { files: { 'index.html': 'hi' } })

  const protectedSite = await json(await call(env, publisher, '/__api/sites/demo/visibility', { body: { visibility: 'password' } }))
  const issued = protectedSite.body.password
  assert.match(issued, /^[a-z2-9]{5}(?:-[a-z2-9]{5}){3}$/)
  const record = storedJson(env, 's:demo')
  assert.equal(record.visibility, 'password')
  assert.equal(record.hash, createHash('sha256').update(`${record.salt}${issued}`).digest('hex'))
  assert.equal(JSON.stringify([...env.SITES.records.values()]).includes(issued), false)
  assert.equal(storedJson(env, 'h:demo.shunagent.site').hash, record.hash)

  assert.equal((await json(await call(env, publisher, '/__api/sites/demo/visibility', { body: { visibility: 'password' } }))).body.password, undefined)
  assert.equal((await json(await call(env, publisher, '/__api/sites/demo/visibility', { body: { visibility: 'public' } }))).body.site.visibility, 'public')
  assert.equal(storedJson(env, 'h:demo.shunagent.site').hash, undefined)
})

test('a site belongs to its publisher: another verified identity cannot manage it', async () => {
  const stranger = await verifiedIdentity('stranger')
  const { publisher, env } = await setup([stranger])
  await publish(env, publisher, 'demo', { files: { 'index.html': 'hi' } })

  assert.equal((await json(await call(env, stranger, '/__api/sites/demo/visibility', { body: { visibility: 'off' } }))).status, 404)
  assert.equal((await json(await call(env, stranger, '/__api/sites/demo', { method: 'DELETE' }))).status, 404)
  assert.equal(storedJson(env, 's:demo').visibility, 'public')

  const removed = await json(await call(env, publisher, '/__api/sites/demo', { method: 'DELETE' }))
  assert.deepEqual({ name: removed.body.name, removed: removed.body.removed }, { name: 'demo', removed: 1 })
  assert.deepEqual(storedJson(env, 'index'), [])
  assert.equal((await service.fetch(new Request('https://demo.shunagent.site/'), env)).status, 404)
})

test('one route serves the API and every published site', async () => {
  const { publisher, env } = await setup()
  await publish(env, publisher, 'demo', { files: { 'index.html': '<h1>served</h1>' } })

  const site = await service.fetch(new Request('https://demo.shunagent.site/'), env)
  assert.equal(site.status, 200)
  assert.equal(await site.text(), '<h1>served</h1>')
  assert.equal(site.headers.get('content-type'), 'text/html; charset=utf-8')

  const state = await json(await call(env, publisher, '/__api/state'))
  assert.equal(state.body.domain, 'shunagent.site')
  assert.deepEqual(state.body.sites.map(item => item.name), ['demo'])
  assert.equal((await service.fetch(new Request('https://nothing-here.shunagent.site/'), env)).status, 404)
})

test('a publisher has a bounded number of sites, and the service has a total ceiling', async () => {
  const { publisher, env } = await setup()
  env.SITES.records.set('p:kyle', { value: JSON.stringify({ sites: Array.from({ length: 25 }, (_, index) => `site-${index}`) }) })
  const refused = await publish(env, publisher, 'demo', { files: { 'index.html': 'hi' } })
  assert.equal(refused.status, 409)
  assert.match(refused.body.error, /25 sites/)

  env.SITES.records.set('p:kyle', { value: JSON.stringify({ sites: [] }) })
  env.SITES.records.set('index', { value: JSON.stringify(Array.from({ length: 2_000 }, (_, index) => `full-${index}`)) })
  const atCapacity = await publish(env, publisher, 'demo', { files: { 'index.html': 'hi' } })
  assert.equal(atCapacity.status, 503)
})
