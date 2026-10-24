import assert from 'node:assert/strict'
import test from 'node:test'
import { withRetrievalDecision } from './web-retrieval-profile.ts'

test('lookup receipts retain source evidence and explain how to finish with an unconfirmed fact', () => {
  const evidence = { results: [{ url: 'https://example.com', snippet: 'lead' }], pages: [{ ok: true, content: 'No release date has been announced.' }], research: { new_evidence: 3 } }
  const receipt = JSON.parse(withRetrievalDecision(JSON.stringify(evidence), 'fact_lookup'))
  assert.deepEqual(receipt.pages, evidence.pages)
  assert.deepEqual(receipt.research, evidence.research)
  assert.match(receipt.retrieval_decision.instruction, /Report uncertainty/)
  assert.match(receipt.retrieval_decision.instruction, /batch independent retrievals/)
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


test('retrieval decisions retain the original question while preserving the exact source evidence', () => {
  const question='When does the next part come out?'
  const source={pages:[{ok:true,requested_url:'https://example.test/source',content:'Two different subjects share this name.'}]}
  const output=JSON.parse(withRetrievalDecision(JSON.stringify(source),'fact_lookup',question))
  assert.equal(output.retrieval_decision.requested_outcome,question)
  assert.deepEqual(output.pages,source.pages)
  assert.match(output.retrieval_decision.instruction,/do not research every branch/)
  assert.equal(JSON.parse(withRetrievalDecision('{}','fact_lookup','x'.repeat(1001))).retrieval_decision.requested_outcome,undefined)
})

test('a lookup distinguishes read pages from search leads and links inside a page', () => {
  const receipt = {
    results: [{url:'https://unread.test/announcement',snippet:'Unverified search lead'}],
    pages: [{ok:true,requested_url:'https://publisher.test/old',final_url:'https://publisher.test/current',title:'Publisher record',content:'The quoted fact. [Other page](https://unread.test/other)',outbound_links:[{url:'https://unread.test/other'}]},
      {ok:false,requested_url:'https://unread.test/failed',content:'Challenge page'},
      {ok:true,final_url:'https://unread.test/empty',content:'   '}],
  }
  const output=JSON.parse(withRetrievalDecision(JSON.stringify(receipt),'fact_lookup','What was announced?'))
  assert.deepEqual(output.retrieval_decision.read_sources,[{url:'https://publisher.test/current',title:'Publisher record'}])
  assert.deepEqual(output.pages,receipt.pages)
  assert.deepEqual(output.results,receipt.results)
})

test('read source attribution supports single-page reads and does not expose credential-bearing URLs', () => {
  const one=JSON.parse(withRetrievalDecision(JSON.stringify({ok:true,url:'https://publisher.test/article',content:'Fetched content'})))
  assert.deepEqual(one.retrieval_decision.read_sources,[{url:'https://publisher.test/article'}])
  const invalid=JSON.parse(withRetrievalDecision(JSON.stringify({pages:[
    {ok:true,final_url:'https://username:secret@publisher.test/article',content:'Fetched content'},
    {ok:true,final_url:'javascript:alert(1)',content:'Unusable target'},
  ]})))
  assert.deepEqual(invalid.retrieval_decision.read_sources,[])
})
