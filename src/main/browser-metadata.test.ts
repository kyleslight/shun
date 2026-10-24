import assert from 'node:assert/strict'
import test from 'node:test'
import { browserTabMetadata, browserSessionMetadata } from './browser-metadata.ts'
import type { BrowserSession } from '../shared.ts'

test('tab inventory preserves popup relationships without copying signed auth queries', () => {
  const token = 'private-auth-material'.repeat(100)
  const tab = { id: 42, openerTabId: 31, windowId: 7, active: false, title: 'Choose an account', url: `https://example.com/authorize?state=${token}#${token}` }
  const reading = browserTabMetadata(tab)
  assert.equal(reading.origin, 'https://example.com')
  assert.equal(reading.path, '/authorize')
  assert.equal(reading.query_present, true)
  assert.equal(reading.fragment_present, true)
  assert.equal(reading.id, 42)
  assert.equal(reading.openerTabId, 31)
  assert.equal(reading.active, undefined)
  assert.equal(JSON.stringify(reading).includes(token), false)
  assert.equal(JSON.stringify(reading).includes('url'), false, 'the summarized destination cannot be mistaken for a full navigation URL')
  assert.equal(tab.url.includes(token), true, 'inventory formatting does not modify the browser resource')
})

test('session inventory keeps ownership identity and discloses unloaded documents without echoing a token', () => {
  const session = { id: 'task-session', tabId: 12, title: 'Sign in', state: 'suspended', url: 'https://example.com/wait?code=private-value' } as BrowserSession
  const reading = browserSessionMetadata(session)
  assert.equal(reading.id, session.id)
  assert.equal(reading.tabId, session.tabId)
  assert.equal(reading.state, 'suspended')
  assert.equal(JSON.stringify(reading).includes('private-value'), false)
  assert.equal(browserTabMetadata({ id: 12, discarded: true, status: 'unloaded' }).render_state, 'unloaded')
})
