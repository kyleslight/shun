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
  assert.deepEqual(result.attachmentIds, ['image', 'audio'])
  assert.throws(() => assistantHandoff(req, parent, 'x', ['answer']), /not found/)
  assert.throws(() => assistantHandoff(req, parent, 'x', ['foreign']), /not found/)
})
