import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantTopicStore, assistantTopicExtension, assistantTopicTools } from './assistant-topics.ts'

test('four topics survive interleaving and restart; stale changes cannot erase a correction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shun-topics-'))
  try {
    const file = join(dir, 'topics.json'), store = new AssistantTopicStore(file)
    const topics = await Promise.all(['video', 'mail', 'inference', 'desktop'].map(title => store.update('main', { messageId: title, text: `Original ${title}` }, { title, state: `${title} requirements` })))
    const fixed = await store.update('main', { messageId: 'correction', text: '60 seconds is the opening, not the entire film' }, { ...topics[0], state: '20 minute film; deliver first 60 seconds' })
    await assert.rejects(store.update('main', { messageId: 'stale', text: 'old' }, { ...topics[0], state: '60 second film' }), /latest revision/)
    const reopened = new AssistantTopicStore(file), all = await reopened.list('main')
    assert.equal(all.length, 4)
    assert.equal(all.find(item => item.id === fixed.id)?.sourceText, '60 seconds is the opening, not the entire film')
    assert.equal(all.find(item => item.title === 'mail')?.state, 'mail requirements')
    assert.equal((await reopened.list('other')).length, 0)
    await assert.rejects(reopened.update('other', { messageId: 'x', text: 'x' }, { ...fixed, state: 'overwrite' }), /not found/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('topic index is appended once per compaction generation, without replacing system prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shun-topics-'))
  try {
    const store = new AssistantTopicStore(join(dir, 'topics.json'))
    await store.update('main', { messageId: 'a', text: 'video request' }, { title: 'video', state: 'Keep voice natural' })
    let hook: any
    assistantTopicExtension(store, 'main')({ on: (_name: string, handler: any) => { hook = handler } } as any)
    const entries: any[] = [], context = { sessionManager: { getBranch: () => entries } }
    const first = await hook({}, context)
    assert.equal(first.systemPrompt, undefined)
    entries.push({ type: 'custom_message', ...first.message })
    assert.equal(await hook({}, context), undefined)
    entries.push({ type: 'compaction', id: 'compact-1' })
    const restored = await hook({}, context)
    assert.equal(restored.message.details.generation, 'compact-1')
    assert.match(restored.message.content, /video/)
    assert.match(restored.message.content, /Keep voice natural/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('topic reads bound original evidence and paginate without losing stored provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shun-topics-read-'))
  try {
    const store = new AssistantTopicStore(join(dir, 'topics.json'))
    let first
    for (let index = 0; index < 52; index++) {
      const topic = await store.update('main', { messageId: `source-${index}`, text: 'x'.repeat(7000) }, { title: `Topic ${index}`, state: 'Confirmed requirement' })
      first ||= topic
    }
    const read = assistantTopicTools(store, 'main', { messageId: 'now', text: '' }, async () => false)[0]
    const decode = async (args: any) => {
      const output = await read.execute('read', args, undefined as any, undefined as any, {} as any)
      const content = output.content[0]
      assert.equal(content.type, 'text')
      return JSON.parse(content.type === 'text' ? content.text : '')
    }
    const page = await decode({})
    assert.equal(page.topics.length, 50)
    assert.equal(page.total, 52)
    assert.equal((await decode({ offset: page.nextOffset })).topics.length, 2)
    const full = await decode({ id: first!.id })
    assert.equal(full.sourceTextOmitted, true)
    assert.equal(full.sourceMessageId, 'source-0')
    assert.equal(full.sourceText, undefined)
    assert.equal((await store.list('main')).find(item => item.id === first!.id)!.sourceText.length, 7000)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
