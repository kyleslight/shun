import { createServer } from 'node:http'
import type { AgentRequest } from '../shared.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { generateTaskTitle, normalizeTaskTitle, taskTitleFromMessage } from './task-title.ts'

test('normalizes task title text', () => {
  assert.equal(normalizeTaskTitle('标题： “修复思考中动画重影。”'), '修复思考中动画重影')
  assert.equal(normalizeTaskTitle('```text\nFix streaming title generation\n```'), 'Fix streaming title generation')
})

test('keeps task titles bounded', () => {
  assert.equal([...normalizeTaskTitle('一'.repeat(80))].length, 48)
})

test('a first-message title is immediate and preserves the user language', () => {
  assert.equal(taskTitleFromMessage('Explain SQLite WAL concurrency'), 'Explain SQLite WAL concurrency')
  assert.equal(taskTitleFromMessage('请解释 SQLite WAL 的并发规则？'), '请解释 SQLite WAL 的并发规则')
  assert.equal(taskTitleFromMessage('\n# Fix cancellation\nDetails follow'), 'Fix cancellation')
  assert.equal(taskTitleFromMessage(''), '')
  assert.equal([...taskTitleFromMessage('🙂'.repeat(70))].length, 48)
})


test('model naming uses the configured provider without tools or a conversation transcript', async t => {
  const requests: any[] = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw); requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const base = { id: 'title', object: 'chat.completion.chunk', model: body.model, created: 1 }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '数据库事务原理' }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`
  const request: AgentRequest = { id: 'first', text: '请详细解释数据库事务是怎么工作的', history: [], settings: {
    endpoint, apiKey: '', providerId: 'fixture', providers: [{ id: 'fixture', name: 'Fixture', kind: 'custom', contextWindow: 32768, endpoint, apiKey: '', api: 'openai-completions' }],
    model: 'title-model', workspace: '', temperature: .2, maxTokens: 1024, contextWindow: 32768, autoCompact: true, language: 'system',
  } }
  assert.equal(await generateTaskTitle(request), '数据库事务原理')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'title-model')
  assert.ok(!requests[0].tools?.length)
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' }
  for (const text of ['', '这个图里的问题怎么修']) {
    assert.equal(await generateTaskTitle({ ...request, text }, undefined, [image]), '数据库事务原理')
    assert.match(JSON.stringify(requests.at(-1).messages), /data:image\/png;base64,aW1hZ2U=/)
  }
  const controller = new AbortController(); controller.abort()
  assert.equal(await generateTaskTitle(request, controller.signal), request.text)
})
