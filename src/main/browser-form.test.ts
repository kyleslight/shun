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
    f.replace([{ ref: '1', role: 'textbox', name: 'Email', value: 'a' }, { ref: '2', role: 'textbox', name: 'Different field' }])
    return f.frame()
  }
  const form = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'a' }, { ref: '2', text: 'b' }])).text).form
  assert.equal(form.status, 'stopped')
  assert.deepEqual(form.completed_refs, ['1'])
  assert.deepEqual(form.remaining_refs, [])
  assert.deepEqual(form.remaining_requested_refs, ['2'])
  assert.equal(form.rebind_required, true)
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
  await assert.rejects(fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'a' }, { ref: '2', text: 'b' }]), /no fields were changed/i)
  assert.equal(f.actions.length, 0)
})

test('a successful dispatch with the wrong value stops before the next field', async () => {
  const f = fixture()
  f.host.act = async (_task, _session, action) => { f.actions.push(action); return f.frame() }
  const form = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'English' }, { ref: '2', text: 'next' }])).text).form
  assert.equal(form.status, 'stopped')
  assert.equal(form.uncertain_ref, '1')
  assert.deepEqual(form.completed_refs, [])
  assert.equal(f.actions.length, 1)
})

test('changing the right value and also another field is reported as uncertain', async () => {
  const f = fixture(), act = f.host.act
  f.host.act = async (...args) => {
    await act(...args)
    f.replace([{ ref: '1', role: 'textbox', name: 'Email', value: 'English' }, { ref: '2', role: 'textbox', name: 'Password', value: 'San JoseEnglish' }])
    return f.frame()
  }
  const form = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'English' }, { ref: '2', text: 'next' }])).text).form
  assert.equal(form.status, 'stopped')
  assert.match(form.reason, /Another field changed/)
  assert.equal(f.actions.length, 1)
})

test('native option values can be verified independently of their accessible labels', async () => {
  const f = fixture(), act = f.host.act
  const host = { ...f.host,
    act: async (...args: Parameters<typeof act>) => {
      await act(...args)
      f.replace([{ ref: '3', role: 'combobox', name: 'Region', value: 'China' }])
      return f.frame()
    },
    verifyField: async () => ({ matches: true, invalid: false, selectionRequired: false }),
  }
  const form = JSON.parse((await fillBrowserForm(host, 'task', 'session', [{ ref: '3', action: 'select', value: 'CN' }])).text).form
  assert.equal(form.status, 'completed')
})

test('a masked field already holding an uncertain input is verified without typing again', async () => {
  const f = fixture()
  f.replace([{ ref: '2', role: 'textbox', name: 'Password', value: '' }])
  const host = { ...f.host, verifyField: async () => ({ matches: true, invalid: false, selectionRequired: false }) }
  const result = await fillBrowserForm(host, 'task', 'session', [{ ref: '2', name: 'Password', text: 'synthetic-pass' }])
  assert.equal(JSON.parse(result.text).form.status, 'completed')
  assert.equal(f.actions.length, 0)
  assert.doesNotMatch(result.text, /synthetic-pass/)
})

test('a changed observation channel returns fresh fields without attempting an input', async () => {
  const f = fixture()
  f.replace([{ ref: 'p:9', role: 'textbox', name: 'Email' }])
  const result = await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', name: 'Email', text: 'synthetic@example.test' }])
  const form = JSON.parse(result.text).form
  assert.equal(form.status, 'stopped')
  assert.equal(form.snapshot_current, true)
  assert.match(form.reason, /refs changed before input/)
  assert.equal(result.snapshot.nodes?.[0].ref, 'p:9')
  assert.equal(f.actions.length, 0)
})

test('an unresponsive preflight verification is not reported as a possibly delivered input', async () => {
  const f = fixture()
  const host = { ...f.host, verifyField: async () => { throw Error('page execution blocked') } }
  const result = await fillBrowserForm(host, 'task', 'session', [{ ref: '2', name: 'Password', text: 'synthetic-pass' }])
  const form = JSON.parse(result.text).form
  assert.equal(form.uncertain_ref, undefined)
  assert.match(form.reason, /No input was sent/)
  assert.equal(f.actions.length, 0)
})

test('autocomplete query text and page validation errors never complete a batch', async () => {
  for (const state of [{ matches: true, invalid: false, selectionRequired: true }, { matches: true, invalid: true, selectionRequired: false }]) {
    const f = fixture()
    const host = { ...f.host, verifyField: async () => state }
    const form = JSON.parse((await fillBrowserForm(host, 'task', 'session', [{ ref: '1', text: 'English' }, { ref: '2', text: 'next' }])).text).form
    assert.equal(form.status, 'stopped')
    assert.equal(form.uncertain_ref, '1')
    assert.equal(f.actions.length, 1)
    assert.match(form.reason, state.selectionRequired ? /explicit option selection/ : /invalid/)
  }
})

test('an explicit field name prevents sending a language value to a location ref', async () => {
  const f = fixture()
  f.replace([{ ref: '1', role: 'textbox', name: 'Location', value: 'San Jose' }])
  await assert.rejects(fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', name: 'Language', text: 'English' }]), /changed its name/)
  assert.equal(f.actions.length, 0)
})

test('resuming a form preserves values that already match instead of typing them again', async () => {
  const f = fixture()
  f.replace([{ ref: '1', role: 'textbox', name: 'Email', value: 'already@example.test' }, { ref: '2', role: 'textbox', name: 'Password' }])
  const form = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'already@example.test' }, { ref: '2', text: 'new' }])).text).form
  assert.equal(form.status, 'completed')
  assert.deepEqual(form.completed_refs, ['1', '2'])
  assert.deepEqual(f.actions.map(action => action.ref), ['2'])
})


test('an isolated page observation can fill a batch without accepting refs from another channel', async () => {
  const f = fixture()
  f.replace([{ ref: 'p:1', role: 'textbox', name: 'Email' }, { ref: 'p:2', role: 'textbox', name: 'Password' }])
  const stale = await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'test@example.test' }])
  assert.equal(JSON.parse(stale.text).form.status, 'stopped')
  assert.match(JSON.parse(stale.text).form.reason, /refs changed before input/)
  assert.equal(f.actions.length, 0)
  const result = await fillBrowserForm(f.host, 'task', 'session', [{ ref: 'p:1', name: 'Email', text: 'test@example.test' }, { ref: 'p:2', name: 'Password', text: 'synthetic-pass' }])
  assert.equal(JSON.parse(result.text).form.status, 'completed')
  assert.deepEqual(f.actions.map(action => action.ref), ['p:1', 'p:2'])
})


test('snapshot display brackets preserve exact refs and cannot bypass duplicate-field checks', async () => {
  const f = fixture()
  const result = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '[1]', text: 'a' }, { ref: '[2]', text: 'b' }])).text)
  assert.equal(result.form.status, 'completed')
  assert.deepEqual(f.actions.map(action => action.ref), ['1', '2'])
  const duplicate = fixture()
  await assert.rejects(fillBrowserForm(duplicate.host, 'task', 'session', [{ ref: '[1]', text: 'a' }, { ref: '1', text: 'b' }]), /distinct fresh/)
  assert.equal(duplicate.actions.length, 0)
})


test('a channel change never advertises historical requested refs as current action targets', async () => {
  const f = fixture(), act = f.host.act
  f.host.act = async (...args) => {
    await act(...args)
    f.replace([{ ref: 'p:1', role: 'textbox', name: 'Email', value: 'a' }, { ref: 'p:2', role: 'textbox', name: 'Password' }])
    throw Error('Observation channel changed after input')
  }
  const form = JSON.parse((await fillBrowserForm(f.host, 'task', 'session', [{ ref: '1', text: 'a' }, { ref: '2', text: 'b' }])).text).form
  assert.equal(form.status, 'stopped')
  assert.equal(form.rebind_required, true)
  assert.deepEqual(form.remaining_refs, [])
  assert.equal(form.uncertain_ref, undefined)
  assert.deepEqual(form.remaining_requested_refs, ['2'])
  assert.equal(form.uncertain_requested_ref, '1')
  assert.equal(f.actions.length, 1)
})
