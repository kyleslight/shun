import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeStableContext } from './provider-context.ts'

const tool = (name: string, description = 'original') => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: {} } } })
const base = () => ({ model: 'local', stream: true, tools: [tool('read')], messages: [
  { role: 'system', content: 'Current instructions.' },
  { role: 'user', content: 'A long reference history.' },
  { role: 'assistant', tool_calls: [{ id: 'discovery-1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'discovery-1', content: 'Found tools.' },
  { role: 'system', tools: [tool('inspect')] },
] })

test('encoding is unchanged initially and across reopened user turns and discovery', () => {
  const original = base(), untouched = structuredClone(original)
  const first = encodeStableContext(original)
  assert.deepEqual(first.payload, original)
  const next = structuredClone(original) as any
  next.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Continue.' })
  const reopened = encodeStableContext(next, JSON.parse(JSON.stringify(first.encoding)))
  assert.deepEqual(reopened.payload.messages.slice(0, first.payload.messages.length), first.payload.messages)
  next.messages.push({ role: 'tool', tool_call_id: 'discovery-2', content: 'Another tool.' }, { role: 'system', tools: [tool('act')] })
  const discovered = encodeStableContext(next, reopened.encoding)
  assert.deepEqual(discovered.payload.messages.slice(0, reopened.payload.messages.length), reopened.payload.messages)
  assert.equal(discovered.encoding.revisions.length, 0)
  assert.deepEqual(original, untouched)
})

test('updated instructions and schemas take effect without rewriting the old prefix', () => {
  const first = encodeStableContext(base())
  const update = base() as any
  update.tools[0] = tool('read', 'new arguments and description')
  update.messages[0].content = 'Updated instructions.'
  update.messages[4].tools = [tool('inspect', 'updated observation')]
  update.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Next.' })
  const changed = encodeStableContext(update, first.encoding)
  assert.deepEqual(changed.payload.tools, first.payload.tools)
  assert.deepEqual(changed.payload.messages.slice(0, first.payload.messages.length), first.payload.messages)
  assert.deepEqual(changed.payload.messages.at(-2), update.messages[0])
  assert.deepEqual(changed.payload.messages.at(-1), { role: 'system', tools: [tool('inspect', 'updated observation'), tool('read', 'new arguments and description')] })
  const next = structuredClone(update)
  next.messages.push({ role: 'assistant', content: 'Updated.' }, { role: 'user', content: 'Again.' })
  const reopened = encodeStableContext(next, JSON.parse(JSON.stringify(changed.encoding)))
  assert.deepEqual(reopened.payload.messages.slice(0, changed.payload.messages.length), changed.payload.messages)
  assert.equal(reopened.encoding.revisions.length, 1)
})

test('removed tools retain historical bytes but are absent from the current registry', () => {
  const first = encodeStableContext(base())
  const removed = base() as any
  removed.messages.pop()
  removed.messages.push({ role: 'user', content: 'The observation plugin was uninstalled.' })
  const next = encodeStableContext(removed, first.encoding)
  assert.deepEqual(next.payload.messages.slice(0, first.payload.messages.length), first.payload.messages)
  assert.deepEqual(next.payload.messages.at(-1), { role: 'system', tools: [], content: 'Unavailable tools: inspect.' })
  const noTools = { ...removed, tools: [] }
  assert.deepEqual(encodeStableContext(noTools, next.encoding).payload.messages.at(-1).tools, [])
})

test('compaction starts a new epoch and branches do not replay unmatched future updates', () => {
  const first = encodeStableContext(base())
  const update = base() as any
  update.messages.push({ role: 'assistant', content: 'A.' }, { role: 'user', content: 'Future branch.' })
  update.tools = [tool('read', 'future')]
  const future = encodeStableContext(update, first.encoding)
  const branch = base() as any
  branch.messages.push({ role: 'assistant', content: 'A.' }, { role: 'user', content: 'Other branch.' })
  const forked = encodeStableContext(branch, future.encoding)
  assert.equal(forked.payload.messages.flatMap((message: any) => message.tools || []).some((tool: any) => tool.function.description === 'future'), false)
  const compacted = { tools: [tool('new')], messages: [{ role: 'system', content: 'New system.' }, { role: 'user', content: 'Compacted summary.' }] }
  assert.deepEqual(encodeStableContext(compacted, future.encoding).payload, compacted)
})

test('image data is preserved exactly when instructions change', () => {
  const input = base() as any
  input.messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,EXACT_IMAGE_BYTES' } }] })
  const first = encodeStableContext(input)
  input.messages[0].content = 'New instructions.'
  const next = encodeStableContext(input, first.encoding)
  assert.deepEqual(next.payload.messages.slice(0, first.payload.messages.length), first.payload.messages)
  assert.equal(next.encoding.revisions.length, 1)
})

test('a schema update sends only its delta, without repeating unchanged tools', () => {
  const input = base() as any
  input.tools.push(...Array.from({ length: 20 }, (_, index) => tool(`unchanged_${index}`)))
  const first = encodeStableContext(input)
  input.tools[0] = tool('read', 'updated')
  const next = encodeStableContext(input, first.encoding)
  assert.deepEqual(next.payload.messages.at(-1), { role: 'system', tools: [tool('read', 'updated')] })
  assert.deepEqual(next.payload.tools, first.payload.tools)
})

test('damaged encoding metadata cannot block a conversation or restore invalid definitions', () => {
  for (const invalid of [{ version: 1 }, { version: 1, root: 'bad', declarations: {}, revisions: [null] }, { version: 1, root: 'bad', declarations: { bad: [null] }, revisions: [] }]) {
    assert.deepEqual(encodeStableContext(base(), invalid as any).payload, base())
  }
})

test('reasoning provider instruction roles preserve the same prefix across instruction updates', () => {
  const input = base() as any
  input.messages[0].role = 'developer'
  const first = encodeStableContext(input)
  input.messages[0].content = 'Updated instructions.'
  const next = encodeStableContext(input, first.encoding)
  assert.deepEqual(next.payload.messages.slice(0, first.payload.messages.length), first.payload.messages)
  assert.deepEqual(next.payload.messages.at(-1), { role: 'developer', content: 'Updated instructions.' })
  assert.equal(next.encoding.root, first.encoding.root)
})

test('workspace metadata follows the first user message without changing instructions, tools or user content', () => {
  const original = base() as any
  original.messages[0].content += '\nCurrent working directory: /work/alpha\n'
  const untouched = structuredClone(original)
  const first = encodeStableContext(original, undefined, '/work/alpha')
  assert.equal(first.payload.messages[0].content, 'Current instructions.\n')
  assert.deepEqual(first.payload.messages[1], original.messages[1])
  assert.deepEqual(first.payload.messages[2], { role: 'system', content: 'Current working directory: /work/alpha\n' })
  assert.deepEqual(first.payload.tools, original.tools)
  assert.deepEqual(original, untouched)
  const next = structuredClone(original)
  next.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Continue.' })
  const reopened = encodeStableContext(next, JSON.parse(JSON.stringify(first.encoding)), '/work/alpha')
  assert.deepEqual(reopened.payload.messages.slice(0, first.payload.messages.length), first.payload.messages)
  assert.equal(reopened.encoding.revisions.length, 0)
})

test('different workspaces share the fixed system and tools while retaining their actual directory', () => {
  const make = (cwd: string) => ({ ...base(), messages: [{ role: 'system', content: `Same instructions.\nCurrent working directory: ${cwd}\n` }, { role: 'user', content: 'Inspect the files.' }] })
  const a = encodeStableContext(make('/work/alpha'), undefined, '/work/alpha')
  const b = encodeStableContext(make('/work/beta'), undefined, '/work/beta')
  assert.deepEqual(a.payload.messages.slice(0, 2), b.payload.messages.slice(0, 2))
  assert.deepEqual(a.payload.tools, b.payload.tools)
  assert.match(a.payload.messages[2].content, /alpha/)
  assert.match(b.payload.messages[2].content, /beta/)
})

test('workspace changes append authoritative metadata without rewriting a saved prefix', () => {
  const original = base() as any
  original.messages[0].content += '\nCurrent working directory: /work/alpha\n'
  const first = encodeStableContext(original, undefined, '/work/alpha')
  const next = structuredClone(original)
  next.messages[0].content = 'Current instructions.\nCurrent working directory: /work/beta\n'
  next.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: 'Inspect this workspace.' })
  const changed = encodeStableContext(next, first.encoding, '/work/beta')
  assert.deepEqual(changed.payload.messages.slice(0, first.payload.messages.length), first.payload.messages)
  assert.deepEqual(changed.payload.messages.at(-1), { role: 'system', content: 'Current working directory: /work/beta\n' })
  const again = encodeStableContext(next, changed.encoding, '/work/beta')
  assert.deepEqual(again.payload, changed.payload)
  assert.equal(again.encoding.revisions.length, 1)
})

test('existing encodings and unmatched workspace footers remain unchanged', () => {
  const original = base() as any
  original.messages[0].content += '\nCurrent working directory: /work/alpha\n'
  const legacy = encodeStableContext(original)
  assert.deepEqual(encodeStableContext(original, legacy.encoding, '/work/alpha').payload, legacy.payload)
  assert.deepEqual(encodeStableContext(original, undefined, '/work/other').payload, original)
  const userOnly = { tools: [], messages: [{ role: 'user', content: 'Current working directory: /work/alpha\n' }] }
  assert.deepEqual(encodeStableContext(userOnly, undefined, '/work/alpha').payload, userOnly)
})

test('a new conversation epoch separates workspace metadata after a legacy encoding', () => {
  const original = { tools: [tool('read')], messages: [{ role: 'system', content: 'Instructions.\nCurrent working directory: /work/alpha\n' }, { role: 'user', content: 'Original request.' }] }
  const legacy = encodeStableContext(original)
  const compacted = structuredClone(original)
  compacted.messages[1].content = 'Compacted conversation summary.'
  const next = encodeStableContext(compacted, legacy.encoding, '/work/alpha')
  assert.ok(next.encoding.workspace)
  assert.equal(next.encoding.revisions.length, 0)
  assert.deepEqual(next.payload.messages[2], { role: 'system', content: 'Current working directory: /work/alpha\n' })
})
