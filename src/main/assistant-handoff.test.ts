import assert from 'node:assert/strict'
import test from 'node:test'
import { assistantHandoff } from './assistant-handoff.ts'
import type { AgentRequest, Task } from '../shared.ts'

test('handoff preserves original corrections and attachment references separately from interpretation', () => {
  const parent = { turns: [{ id: 'old', role: 'user', content: '20分钟的片子', attachments: [{ id: 'image' }] }, { id: 'answer', role: 'assistant', content: 'wrong interpretation' }] } as Task
  const req = { id: 'run', messageId: 'new', text: '只做开头60秒，不是把整片压缩成60秒', attachments: [{ id: 'image' }, { id: 'audio' }] } as AgentRequest
  const result = assistantHandoff(req, parent, 'Coordinator interpretation', ['old', 'old'])
  assert.match(result.text, /20分钟的片子/)
  assert.match(result.text, /只做开头60秒，不是把整片压缩成60秒/)
  assert.match(result.text, /interpretation, not a replacement/)
  assert.equal(result.displayText, '20分钟的片子\n\n只做开头60秒，不是把整片压缩成60秒')
  assert.deepEqual(result.attachmentIds, ['image', 'audio'])
  assert.throws(() => assistantHandoff(req, parent, 'x', ['answer']), /not found/)
  assert.throws(() => assistantHandoff(req, parent, 'x', ['foreign']), /not found/)
})

test('continuing RSS does not implicitly forward a separate project question or image', () => {
  const parent = { turns: [{ id: 'rss', role: 'user', content: '继续发布 RSS', attachments: [{ id: 'rss-image' }] }] } as Task
  const req = { id: 'run', messageId: 'new', text: '另外，Dim Dum 这是在干嘛', attachments: [{ id: 'dimsum-image' }] } as AgentRequest
  const unrelated = assistantHandoff(req, parent, 'Continue the existing RSS upload', [], false)
  assert.equal(unrelated.displayText, 'Continue the existing RSS upload')
  assert.doesNotMatch(unrelated.text, /Dim Dum/)
  assert.deepEqual(unrelated.attachmentIds, [])
  const selected = assistantHandoff(req, parent, 'Continue RSS', ['rss'], false)
  assert.match(selected.text, /继续发布 RSS/)
  assert.doesNotMatch(selected.text, /Dim Dum/)
  assert.deepEqual(selected.attachmentIds, ['rss-image'])
  const related = assistantHandoff(req, parent, 'Inspect the dim sum output', [], true)
  assert.match(related.text, /Dim Dum/)
  assert.deepEqual(related.attachmentIds, ['dimsum-image'])
})
