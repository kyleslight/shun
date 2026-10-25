import assert from 'node:assert/strict'
import test from 'node:test'
import {readWithSourceRecovery, SourceNotFoundError} from './web-source-recovery.ts'
import {retrievalBatch} from './web-retrieval-batch.ts'
import {readSources} from './web-retrieval-profile.ts'

const alternative={ok:true,requested_url:'https://publisher.test/docs/current',final_url:'https://publisher.test/docs/current',content:'Visitors require the Team plan.'}

test('missing sibling paths share one discovery and retain the actual source identity',async()=>{
  const recoveries=new Map<string,Promise<string>>()
  let discoveries=0
  const read=(url:string)=>readWithSourceRecovery({url,query:'visitor plan'},async()=>{throw new SourceNotFoundError(url,'404')},async(query,site)=>{
    discoveries++;assert.equal(query,'visitor plan');assert.equal(site,'publisher.test')
    return JSON.stringify({results:[{url:alternative.final_url}],pages:[alternative],evidence_status:'page_excerpts'})
  },recoveries)
  const receipt=JSON.parse(await retrievalBatch('read',['https://publisher.test/docs/old','https://publisher.test/docs/assumed'],read))
  assert.equal(discoveries,1)
  assert.equal(receipt.pages.length,1)
  assert.equal(receipt.pages[0].final_url,alternative.final_url)
  assert.equal(receipt.responses[0].source_recovery.requested_url,'https://publisher.test/docs/old')
  assert.deepEqual(readSources(receipt),[{url:alternative.final_url}])
})

test('successful sources and transport errors never trigger missing-page discovery',async()=>{
  const discover=async()=>{throw Error('unexpected discovery')}
  assert.equal(await readWithSourceRecovery({url:'https://publisher.test/source',query:'fact'},async()=> 'original receipt',discover),'original receipt')
  const timeout=Error('request timed out')
  await assert.rejects(readWithSourceRecovery({url:'https://publisher.test/source',query:'fact'},async()=>{throw timeout},discover),error=>error===timeout)
  const missing=new SourceNotFoundError('https://publisher.test/missing','404')
  await assert.rejects(readWithSourceRecovery({url:missing.url},async()=>{throw missing},discover),error=>error===missing)
})

test('unread alternatives remain leads and cannot be attributed to the missing page',async()=>{
  const url='https://publisher.test/missing'
  const receipt=JSON.parse(await readWithSourceRecovery({url,query:'fact'},async()=>{throw new SourceNotFoundError(url,'soft 404')},async()=>JSON.stringify({results:[{url:alternative.final_url}]})))
  assert.equal(receipt.ok,false)
  assert.equal(receipt.source_recovery.status,'soft 404')
  assert.deepEqual(readSources(receipt),[])
  assert.match(receipt.recovery_note,/not the original page/)
})

test('cancellation during rediscovery propagates without another lookup',async()=>{
  const controller=new AbortController(),cancelled=Error('cancelled')
  const url='https://publisher.test/missing'
  await assert.rejects(readWithSourceRecovery({url,query:'fact',signal:controller.signal},async()=>{throw new SourceNotFoundError(url,'404')},async()=>{
    controller.abort(cancelled);throw cancelled
  }),error=>error===cancelled)
})
