import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProviderSettingsStore } from './provider-settings.ts'
import { mergeProviderSettings, type ProviderSettings } from '../provider-settings.ts'

const initial = (): ProviderSettings => ({ providers: [{ id: 'desktop', name: 'Desktop provider', kind: 'custom', endpoint: 'https://example.com/v1', apiKey: 'fixture-secret', contextWindow: 64000 }], providerId: 'desktop', model: 'desktop-model', endpoint: 'https://example.com/v1', apiKey: 'fixture-secret', contextWindow: 64000, maxTokens: 8000 })
const empty = (): ProviderSettings => ({ ...initial(), providers: [], providerId: '', model: '', endpoint: '', apiKey: '' })

test('existing desktop configuration is used without setup and changes are shared across clients', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shun-providers-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacyFile = join(root, 'desktop.json'), file = join(root, 'providers.json')
  await writeFile(legacyFile, JSON.stringify({ settings: initial(), tasks: [{ id: 'untouched' }] }))
  const cli = new ProviderSettingsStore(file, legacyFile), desktop = new ProviderSettingsStore(file, legacyFile)
  const base = await cli.sync(empty())
  assert.deepEqual(base, initial())
  const next = structuredClone(base); next.providers[0].apiKey = 'new-key'; next.model = 'new-model'
  await cli.sync(base, { next, base })
  const shared = await desktop.sync(initial())
  assert.equal(shared.model, 'new-model'); assert.equal(shared.apiKey, 'new-key')
  assert.deepEqual(JSON.parse(await readFile(legacyFile, 'utf8')).tasks, [{ id: 'untouched' }])
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600)
  // An older desktop's unrelated save must not undo the CLI's model/key change.
  await writeFile(legacyFile, JSON.stringify({ settings: { ...initial(), theme: 'dark' }, tasks: [] }))
  assert.equal((await cli.sync(empty())).model, 'new-model')
  const changed = initial(); changed.providers[0].name = 'Renamed in desktop'
  await writeFile(legacyFile, JSON.stringify({ settings: changed, tasks: [] }))
  const merged = await cli.sync(empty())
  assert.equal(merged.providers[0].name, 'Renamed in desktop')
  assert.equal(merged.apiKey, 'new-key')
})

test('concurrent clients preserve independent provider edits and do not resurrect removed connections', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shun-provider-race-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const a = new ProviderSettingsStore(join(root, 'providers.json')), b = new ProviderSettingsStore(a.file)
  const base = await a.sync(initial()), left = structuredClone(base), right = structuredClone(base)
  left.providers[0].name = 'Renamed'; right.providers[0].apiKey = 'rotated-key'
  await Promise.all([a.sync(base, { next: left, base }), b.sync(base, { next: right, base })])
  const final = await a.sync(base)
  assert.equal(final.providers[0].name, 'Renamed'); assert.equal(final.providers[0].apiKey, 'rotated-key')
  const removed = mergeProviderSettings(final, empty(), base)
  assert.deepEqual(mergeProviderSettings(removed, right, base).providers, [])
})

test('an upgraded desktop uses shared settings and its conversation saves cannot replay stale credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'shun-provider-upgrade-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const legacy = join(root, 'state.json'), file = join(root, 'providers.json')
  await writeFile(legacy, JSON.stringify({ settings: initial(), tasks: [] }))
  const desktop = new ProviderSettingsStore(file, legacy, true), cli = new ProviderSettingsStore(file, legacy)
  const base = await desktop.sync(empty()), edited = structuredClone(base)
  edited.providers[0].apiKey = 'rotated-in-terminal'
  edited.model = 'terminal-model'
  await cli.sync(base, { next: edited, base })
  await writeFile(legacy, JSON.stringify({ settings: { ...initial(), model: 'old-ui-model' }, tasks: [] }))
  const current = await desktop.sync(initial(), { next: initial(), base })
  assert.equal(current.apiKey, 'rotated-in-terminal')
  assert.equal(current.model, 'terminal-model')
})
