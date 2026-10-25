import assert from 'node:assert/strict'
import test from 'node:test'
import {discoverSourceAlternatives, readWithSourceRecovery, SourceNotFoundError} from './web-source-recovery.ts'
import {retrievalBatch} from './web-retrieval-batch.ts'
import {readSources} from './web-retrieval-profile.ts'
import {supplementSearchEvidence} from './web-evidence.ts'
import {queryWindow} from './content-window.ts'
import {rankAndDedupe} from './web.ts'

const alternative={ok:true,requested_url:'https://publisher.test/docs/current',final_url:'https://publisher.test/docs/current',content:'Visitors require the Team plan.'}

test('recovery merges query candidates before reading and skips complete sources already in context',async()=>{
  const first={url:'https://publisher.test/docs/roles',title:'Guest plans – Publisher',content:'Guest accounts require a paid plan.'}
  const second={url:'https://publisher.test/docs/plans',title:'Guest plan billing – Publisher',content:'Guest accounts use the Team plan.'}
  const home={url:'https://publisher.test/',title:'Publisher',content:'Product homepage.'}
  let started=0,release!:()=>void,readBatches=0
  const bothStarted=new Promise<void>(resolve=>{release=resolve})
  const fetched:string[]=[]
  const output=JSON.parse(await discoverSourceAlternatives(['publisher guest plan','publisher guest plan site:publisher.test/docs'],async query=>{
    if(++started===2)release()
    await bothStarted
    return JSON.stringify({results:query.includes('/docs')?[second,first]:[home,first]})
  },rows=>rankAndDedupe('publisher guest plan site:publisher.test',rows,10),async discovery=>{
    readBatches++
    return supplementSearchEvidence(discovery,{query:'guest plan',alreadyReadUrls:new Set([first.url]),maxPages:2,read:async url=>{
      fetched.push(url)
      return JSON.stringify({ok:true,final_url:url,content:url===second.url?'Guest accounts use the Team plan.':'Product homepage.'})
    }})
  }))
  assert.equal(started,2)
  assert.equal(readBatches,1)
  assert.equal(output.results.length,3)
  assert.equal(fetched.includes(first.url),false)
  assert.equal(new Set(fetched).size,fetched.length)
  assert.ok(output.pages.some((page:any)=>page.content==='Guest accounts use the Team plan.'))
  assert.deepEqual(output.previously_read_sources,[first.url])
})

test('missing-page recovery preserves the requested reading window and later plan conditions',async()=>{
  const content='## Workspace roles\n\n'+('Free plan administrators manage workspace accounts.\n\n'.repeat(120))+'## Visitors\n\nVisitor accounts are only available on the Team plan.'
  const receipt=JSON.parse(await readWithSourceRecovery({url:'https://publisher.test/docs/old',query:'free plan accounts',maxChars:12000},
    async()=>{throw new SourceNotFoundError('https://publisher.test/docs/old','404')},
    async(query,_site,_source,maxChars)=>supplementSearchEvidence(JSON.stringify({results:[{url:alternative.final_url}]}),{
      query,maxChars,read:async(url,query,limit)=>JSON.stringify({ok:true,final_url:url,...queryWindow(content,query,limit,0)}),
    })))
  assert.equal(receipt.pages[0].content,content)
  assert.match(receipt.pages[0].content,/only available on the Team plan/)
})

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
