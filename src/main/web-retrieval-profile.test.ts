import assert from 'node:assert/strict'
import test from 'node:test'
import { withRetrievalDecision } from './web-retrieval-profile.ts'

test('lookup receipts retain source evidence and explain how to finish with an unconfirmed fact', () => {
  const evidence = { results: [{ url: 'https://example.com', snippet: 'lead' }], pages: [{ ok: true, content: 'No release date has been announced.' }], research: { new_evidence: 3 } }
  const receipt = JSON.parse(withRetrievalDecision(JSON.stringify(evidence), 'fact_lookup'))
  assert.deepEqual(receipt.pages, evidence.pages)
  assert.deepEqual(receipt.research, evidence.research)
  assert.match(receipt.retrieval_decision.instruction, /report that uncertainty now/)
  assert.match(receipt.retrieval_decision.instruction, /batch independent queries and reads/)
  assert.equal(receipt.blocked, undefined)
})

test('investigation receipts preserve their broader scope without revoking retrieval or inventing a quota', () => {
  const receipt = JSON.parse(withRetrievalDecision('{"ok":false,"error":"unavailable"}', 'deep_research'))
  assert.equal(receipt.ok, false)
  assert.equal(receipt.error, 'unavailable')
  assert.equal(receipt.retrieval_decision.depth, 'deep_research')
  assert.match(receipt.retrieval_decision.instruction, /unresolved parts/)
  assert.equal(receipt.blocked, undefined)
  assert.equal(withRetrievalDecision('plain response', 'fact_lookup'), 'plain response')
})
