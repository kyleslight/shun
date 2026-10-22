import assert from 'node:assert/strict'
import test from 'node:test'
import { fillBrowserForm } from './browser-form.ts'
import type { BrowserAction } from './chrome-browser.ts'
import type { BrowserSession } from '../shared.ts'

function fixture() {
  const session = { id: 'session', url: 'https://example.test/login' } as BrowserSession
  let nodes: Array<Record<string, any>> = [
    { ref: '1', role: 'textbox', name: 'Email' }, { ref: '2', role: 'textbox', name: 'Password' },
    { ref: '3', role: 'combobox', name: 'Region' }, { ref: '4', role: 'button', name: 'Sign in' },
  ]
  const actions: BrowserAction[] = []
  const frame = () => ({ session, snapshot: { tab: { id: 42, url: session.url }, nodes: structuredClone(nodes) }, text: '{}' })
  const host = {
    snapshot: async () => frame(),
    act: async (_task: string, _session: unknown, action: BrowserAction) => {
      actions.push(action)
      const field = nodes.find(n => n.ref === action.ref)!
      field.value = action.text ?? action.value
      return frame()
    },
  }
  return { host, session, actions, frame, replace: (next: typeof nodes) => { nodes = next } }
}

test('one form call fills multiple explicit fields without clicking or submitting', async () => {
  const f = fixture()
  const result = await fillBrowserForm(f.host, 'task', 'session', [
    { ref: '1', text: 'test@example.test' }, { ref: '2', text: 'synthetic-pass' }, { ref: '3', action: 'select', value: 'CN' },
  ])
  const form = JSON.parse(result.text).form
  assert.equal(form.status, 'completed')
  assert.deepEqual(form.completed_refs, ['1', '2', '3'])
  assert.equal(form.submitted, false)
  assert.deepEqual(f.actions.map(a => a.action), ['type', 'type', 'select'])
  assert.doesNotMatch(result.text, /synthetic-pass/)
})

test('invalid or ambiguous batches touch no fields', async () => {
  for (const fields of [[], [{ ref: '1', text: 'a' }, { ref: '1', text: 'b' }], [{ ref: '4', text: 'not a textbox' }], [{ ref: 'missing', text: 'a' }]]) {
    const f = fixture()
    await assert.rejects(fillBrowserForm(f.host, 'task', 'session', fields))
    assert.equal(f.actions.length, 0)
  }
})

test('a dynamic form stops at a changed field and never replays completed inputs', async () => {
  const f = fixture(), act = f.host.act
  f.host.act = async (...args) => {
    await act(...args)
    f.replace([{ ref: '1', role: 'textbox', name: 'Email' }, { ref: '2', role: 'textbox', name: 'Different field' }])
    return f.frame()
  }
  const form = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'a' }, { ref: '2', text: 'b' }])).text).form
  assert.equal(form.status, 'stopped')
  assert.deepEqual(form.completed_refs, ['1'])
  assert.deepEqual(form.remaining_refs, ['2'])
  assert.equal(f.actions.length, 1)
})

test('a navigation during input stops remaining fields', async () => {
  const f = fixture(), act = f.host.act
  f.host.act = async (...args) => { await act(...args); f.session.url = 'https://example.test/next'; return f.frame() }
  const form = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'a' }, { ref: '2', text: 'b' }])).text).form
  assert.match(form.reason, /navigated/)
  assert.equal(f.actions.length, 1)
})

test('lost input confirmation is uncertain rather than automatically typed again', async () => {
  const f = fixture(), act = f.host.act
  f.host.act = async (...args) => { await act(...args); throw Error('response lost') }
  const form = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'a' }, { ref: '2', text: 'b' }])).text).form
  assert.equal(form.uncertain_ref, '1')
  assert.deepEqual(form.completed_refs, [])
  assert.deepEqual(form.remaining_refs, ['2'])
  assert.equal(form.snapshot_current, true)
  assert.equal(f.actions.length, 1)
})

test('readonly fields are rejected before any input', async () => {
  const f = fixture()
  f.replace([{ ref: '1', role: 'textbox', name: 'Email' }, { ref: '2', role: 'textbox', name: 'Password', readonly: true }])
  await assert.rejects(fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'a' }, { ref: '2', text: 'b' }]), /no fields were changed/)
  assert.equal(f.actions.length, 0)
})
