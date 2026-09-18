import assert from 'node:assert/strict'
import test from 'node:test'
import { recordPlan } from './ensure-domain.mjs'

test('the publishing domain is provisioned once, and re-running changes nothing', () => {
  assert.deepEqual(recordPlan([]), { create: true, record: { type: 'AAAA', name: '*.shunagent.site', content: '100::', proxied: true } })
  assert.equal(recordPlan([{ name: '*.shunagent.site', type: 'AAAA' }]).create, false)
  // A deployment must not touch records it did not create.
  assert.equal(recordPlan([{ name: 'shunagent.site', type: 'A' }]).create, true)
})
