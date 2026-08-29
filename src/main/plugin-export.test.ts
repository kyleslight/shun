import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_PLUGIN_EXPORT_BYTES, pluginExportCandidate, pluginExportPayload } from './plugin-export.ts'

test('plugin export accepts bounded binary data and strips path components', () => {
  const data = new Uint8Array([37, 80, 68, 70])
  const result = pluginExportPayload({ name: '../draft.pdf', data })
  assert.equal(result.name, 'draft.pdf')
  assert.deepEqual([...result.bytes], [...data])
})

test('plugin export rejects empty and oversized data', () => {
  assert.throws(() => pluginExportPayload({ name: 'draft.pdf', data: new Uint8Array() }), /empty or invalid/)
  assert.throws(() => pluginExportPayload({ name: 'draft.pdf', data: new Uint8Array(MAX_PLUGIN_EXPORT_BYTES + 1) }), /64 MB/)
})

test('plugin export produces non-destructive duplicate names', () => {
  assert.equal(pluginExportCandidate('draft.pdf', 0), 'draft.pdf')
  assert.equal(pluginExportCandidate('draft.pdf', 1), 'draft 2.pdf')
  assert.equal(pluginExportCandidate('draft', 2), 'draft 3')
})
