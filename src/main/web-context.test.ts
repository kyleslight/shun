import assert from 'node:assert/strict'
import test from 'node:test'
import { projectWebEvidence } from './web-context.ts'

function result(id: string, receipt: unknown, toolName = 'web_search'): any {
  return { role: 'toolResult', toolName, toolCallId: id, isError: false, timestamp: 1, content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }] }
}
const page = { ok: true, final_url: 'https://publisher.test/limits', content_offset: 0, has_more: true,
  published: '2026-10-28', content: 'Includes 500 builds. Guests require the Team plan. This is not unlimited.' }
const read = (message: any) => JSON.parse(message.content[0].text)

test('contained re-reads retain exact conditions through an unambiguous earlier window reference', () => {
  const middle = 'Guest access requires a paid plan. '.repeat(30)
  const original = { ...page, content_offset: 200, content: `Before. ${middle} After.` }
  const messages = [result('large', { pages: [original] }), result('small', { ...page, content_offset: 208, content: middle }),
    result('changed', { ...page, content_offset: 208, content: middle.replace('paid', 'business') })]
  const saved = JSON.stringify(messages), output = projectWebEvidence(messages)
  const reference = read(output[1]).content_reference
  assert.equal(reference.tool_call_id, 'large')
  assert.equal(reference.source_content_offset, 200)
  assert.equal(original.content.slice(reference.text_start, reference.text_end), middle)
  assert.equal(read(output[1]).content, undefined)
  assert.match(read(output[2]).content, /business plan/)
  assert.equal(read(projectWebEvidence(messages.slice(1))[0]).content, middle)
  assert.equal(JSON.stringify(messages), saved)
})

test('projection keeps every unique passage, condition, source and pagination marker without modifying history', () => {
  const receipt = { results: [{ url: 'https://lead.test', snippet: 'Unverified lead', match: { confidence: 'lead' } }],
    pages: [page], retrieval: { depth: 'fact_lookup', providers: [{ id: 'transport', latency_ms: 100 }] } }
  const messages = [result('one', receipt), result('two', { ...page, content_offset: 200, content: 'Additional restrictions apply.' }, 'web_read')]
  const saved = JSON.stringify(messages)
  const projected = projectWebEvidence(messages)
  assert.deepEqual(read(projected[0]).pages, [page])
  assert.deepEqual(read(projected[0]).results, receipt.results)
  assert.deepEqual(read(projected[1]), { ...page, content_offset: 200, content: 'Additional restrictions apply.' })
  assert.equal(read(projected[0]).retrieval.providers, undefined)
  assert.equal(JSON.stringify(messages), saved)
})

test('identical passages refer to retained text; changed facts and different publishers remain explicit', () => {
  const messages = [result('first', { pages: [page] }), result('repeat', { ...page, published: '2026-10-29' }, 'web_read'),
    result('changed', { ...page, content: 'Now includes 100 builds.' }), result('other', { ...page, final_url: 'https://other.test/limits' })]
  const projected = projectWebEvidence(messages)
  assert.equal(read(projected[0]).pages[0].content, page.content)
  assert.equal(read(projected[1]).content, undefined)
  assert.equal(read(projected[1]).content_reference.tool_call_id, 'first')
  assert.equal(read(projected[1]).published, '2026-10-29')
  assert.equal(read(projected[2]).content, 'Now includes 100 builds.')
  assert.equal(read(projected[3]).content, page.content)
  // Compaction/branching cannot leave references to absent messages.
  assert.equal(read(projectWebEvidence(messages.slice(1))[0]).content, page.content)
  assert.deepEqual(projectWebEvidence(messages), projected)
})

test('only repeated instructions are removed; failures, other tools and non-text blocks remain intact', () => {
  const receipt = { pages: [page], retrieval_decision: { depth: 'fact_lookup', instruction: 'Use evidence', requested_outcome: 'Question' } }
  const messages = [result('one', receipt), result('two', receipt), result('deep', { retrieval_decision: { instruction: 'Investigate gaps' } }),
    result('other', receipt, 'read'), { ...result('error', receipt), isError: true }, result('plain', {})]
  messages[5].content = [{ type: 'text', text: 'Not JSON' }, { type: 'image', data: 'fixture', mimeType: 'image/png' }]
  const projected = projectWebEvidence(messages)
  assert.equal(read(projected[0]).retrieval_decision.instruction, 'Use evidence')
  assert.deepEqual(read(projected[1]).retrieval_decision, { depth: 'fact_lookup', requested_outcome: 'Question' })
  assert.equal(read(projected[2]).retrieval_decision.instruction, 'Investigate gaps')
  for (const index of [3, 4, 5]) assert.equal(projected[index], messages[index])
})

test('completed-turn evidence is recoverable while current evidence and saved history remain complete',()=>{
  const longPage={...page,content:'Plan terms. '.repeat(500)+'Guests require a paid plan.'}
  const old=result('old',{pages:[longPage]})
  const messages:any[]=[{role:'user',content:'First question'},old,{role:'assistant',stopReason:'stop',content:[]},
    {role:'user',content:'Follow-up'},result('current',{pages:[longPage]})]
  const saved=JSON.stringify(messages)
  const projected=projectWebEvidence(messages,{archiveCompleted:true})
  assert.equal(read(projected[1]).archived_web_evidence,true)
  assert.equal(read(projected[1]).sources[0].url,page.final_url)
  assert.equal(read(projected[1]).tool_call_id,'old')
  assert.equal(read(projected[1]).read_tool,'web_history_read')
  assert.equal(read(projected[4]).pages[0].content,longPage.content)
  assert.equal(JSON.stringify(messages),saved)
  assert.equal(read(projectWebEvidence(messages)[1]).pages[0].content,longPage.content)
  messages[2].stopReason='toolUse'
  assert.equal(read(projectWebEvidence(messages,{archiveCompleted:true})[1]).pages[0].content,longPage.content)
})

test('only completed web-only turns omit scratch reasoning, retaining calls and visible answers',()=>{
  const thinking={type:'thinking',thinking:'Private scratch work'}
  const call={type:'toolCall',id:'one',name:'web_read',arguments:{url:'https://publisher.test'}}
  const messages:any[]=[{role:'user',content:'First'}, {role:'assistant',content:[thinking,call],stopReason:'toolUse'},
    result('one',page,'web_read'),{role:'assistant',content:[thinking,{type:'text',text:'The supported answer.'}],stopReason:'stop'},
    {role:'user',content:'Follow-up'}, {role:'assistant',content:[thinking],stopReason:'toolUse'}]
  const saved=JSON.stringify(messages),out=projectWebEvidence(messages,{archiveCompleted:true})
  assert.ok(out[1].role==='assistant'); assert.deepEqual(out[1].content,[call])
  assert.ok(out[3].role==='assistant'); assert.deepEqual(out[3].content,[{type:'text',text:'The supported answer.'}])
  assert.equal(out[5],messages[5])
  assert.equal(JSON.stringify(messages),saved)
  messages.splice(3,0,result('code',{content:'Code'},'bash'))
  assert.equal(projectWebEvidence(messages,{archiveCompleted:true})[1],messages[1])
})


test('ranking diagnostics do not consume evidence context or erase qualification signals', () => {
  const lead = { url: 'https://publisher.test/result', title: 'Limits', snippet: 'Only paid plans include guests.',
    engine: 'transport-a', source_class: 'primary', match: { confidence: 'lead', subject_match: false,
      source_site_match: true, exact_phrase_matches: 2, title_exact_phrase_matches: 1, matched_terms: 5, term_coverage: .8 } }
  const receipt = { results: [lead], pages: [page], responses: [{ target: 'limits', ok: false, error: 'Unavailable', started_at: 1, finished_at: 2 }] }
  const message = result('diagnostics', receipt), before = JSON.stringify(message)
  const projected = read(projectWebEvidence([message])[0])
  assert.deepEqual(projected.results, [{ ...lead, engine: undefined, match: { confidence: 'lead', subject_match: false, source_site_match: true } }].map(({engine, ...row}) => row))
  assert.deepEqual(projected.pages, [page])
  assert.deepEqual(projected.responses, [{ target: 'limits', ok: false, error: 'Unavailable' }])
  assert.equal(JSON.stringify(message), before)
})
