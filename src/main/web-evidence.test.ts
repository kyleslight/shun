import assert from 'node:assert/strict'
import test from 'node:test'
import { createSearchReadAhead, supplementSearchEvidence, withSourceReadWindow } from './web-evidence.ts'
import { rankAndDedupe } from './web.ts'
import {queryWindow} from './content-window.ts'
import {retrievalProfile} from './web-retrieval-profile.ts'

const discovery = JSON.stringify({results: [
  {title: 'Reference one', url: 'https://one.example/reference', match: {confidence: 'direct'}},
  {title: 'Reference two', url: 'https://two.example/reference', match: {confidence: 'direct'}},
  {title: 'Third lead', url: 'https://three.example/reference'},
]})

test('a publisher lead is read even when its preview omits a quoted qualification', async () => {
  const query='ExampleBrand docs "guest accounts" plan'
  const results=rankAndDedupe(query,[{url:'https://examplebrand.test/docs/roles',title:'Roles and access',content:'Workspace roles and plan conditions.'}])
  const fetched:string[]=[]
  const output=JSON.parse(await supplementSearchEvidence(JSON.stringify({results}),{query,read:async url=>{
    fetched.push(url)
    return page(url,'Guest accounts are available only on the Team plan.')
  }}))
  assert.deepEqual(fetched,['https://examplebrand.test/docs/roles'])
  assert.equal(output.results[0].match.exact_phrase_matches,0)
  assert.equal(output.pages[0].content,'Guest accounts are available only on the Team plan.')
  assert.equal(output.evidence_status,'page_excerpts')
})
function page(url: string, content = 'Source evidence') {
  return JSON.stringify({ok: true, requested_url: url, final_url: url, title: 'Reference', content_type: 'text/plain', content_offset: 100, content_end: 100 + content.length, content_characters: 10000, has_more: true, content})
}

test('numbered product discovery does not read another version as subject evidence',async()=>{
  const query='Atlas 3 official release date'
  const results=rankAndDedupe(query,[
    {url:'https://news.test/old',title:'Atlas 2 official release date',snippet:'Version 2 released in 2023.'},
    {url:'https://news.test/current',title:'Atlas 3 release date',snippet:'No official date has been announced.'},
    {url:'https://news.test/other',title:'Atlas 30 official release date',snippet:'A different release.'},
  ],5)
  assert.equal(results.find(r=>r.url.endsWith('/old'))?.match.subject_match,false)
  assert.equal(results.find(r=>r.url.endsWith('/other'))?.match.subject_match,false)
  assert.equal(results[0].url,'https://news.test/current')
  const fetched:string[]=[]
  await supplementSearchEvidence(JSON.stringify({results}),{query,read:async url=>{fetched.push(url);return page(url)}})
  assert.deepEqual(fetched,['https://news.test/current'])
  const minor=rankAndDedupe('Atlas 3.2 support policy',[
    {url:'https://news.test/previous',title:'Atlas 3.1 support policy'},
    {url:'https://news.test/minor',title:'Atlas 3.2 support policy'},
  ])
  assert.equal(minor[0].url,'https://news.test/minor')
  assert.equal(minor.find(r=>r.url.endsWith('/previous'))?.match.subject_match,false)
})

test('search excerpts retain source attribution, publication dates and link truncation provenance', async () => {
  const output = JSON.parse(await supplementSearchEvidence(discovery, { query: 'source', read: async url => JSON.stringify({
    ...JSON.parse(page(url)), published: '2023-08-30', author: 'An author', site: 'Publisher',
    outbound_links: Array.from({ length: 8 }, (_, i) => ({ title: `Source ${i}`, url: `https://publisher.test/${i}`, ...(i === 0 ? { relationship: 'external_resource' } : {}) })),
    outbound_link_count: 50, outbound_links_truncated: true,
  }) }))
  assert.equal(output.pages[0].published, '2023-08-30')
  assert.equal(output.pages[0].author, 'An author')
  assert.equal(output.pages[0].site, 'Publisher')
  assert.equal(output.pages[0].outbound_links.length, 4)
  assert.equal(output.pages[0].outbound_links[0].relationship, 'external_resource')
  assert.equal(output.pages[0].outbound_link_count, 50)
  assert.equal(output.pages[0].outbound_links_truncated, true)
})

test('expanded queries retain and read subject-matching references when the primary source is blocked', async () => {
  const query = 'ExampleBrand free version pricing subscription monthly cost 2026'
  const results = rankAndDedupe(query, [
    { title: 'ExampleBrand', url: 'https://examplebrand.test', content: 'Application homepage.' },
    { title: 'ExampleBrand', url: 'https://reference.test/wiki/ExampleBrand', content: 'An overview of the application.' },
  ], 3, true)
  const fetched: string[] = []
  const output = JSON.parse(await supplementSearchEvidence(JSON.stringify({ results }), {
    query,
    read: async url => {
      fetched.push(url)
      if (new URL(url).hostname === 'examplebrand.test') throw Error('Source unavailable')
      return page(url, 'ExampleBrand offers a free version.')
    },
  }))
  assert.deepEqual(fetched.sort(), ['https://examplebrand.test/', 'https://reference.test/wiki/ExampleBrand'])
  assert.equal(output.evidence_status, 'page_excerpts')
  assert.equal(output.pages.find((entry: any) => entry.ok)?.content, 'ExampleBrand offers a free version.')
})

test('source reads overlap, remain bounded, and retain provenance separately from snippets', async () => {
  const started: string[] = []
  let release!: () => void
  const bothStarted = new Promise<void>(resolve => { release = resolve })
  const result = JSON.parse(await supplementSearchEvidence(discovery, {query: 'specific evidence', read: async (url, query, maxChars) => {
    started.push(url)
    assert.equal(query, 'specific evidence')
    assert.equal(maxChars, 3000)
    if (started.length === 2) release()
    await bothStarted
    return page(url)
  }}))
  assert.equal(started.length, 2)
  assert.equal(result.results.length, 3)
  assert.equal(result.pages.length, 2)
  assert.equal(result.evidence_status, 'page_excerpts')
  assert.equal(result.pages[0].final_url, 'https://one.example/reference')
  assert.equal(result.pages[0].content, 'Source evidence')
  assert.equal(result.pages[0].content_offset, 100)
})

test('explicit source reading windows retain conditions beyond the discovery excerpt bound',async()=>{
  const content='Workspace policy.\n'.repeat(1000)+'Visitors require a paid plan.'
  const output=JSON.parse(await supplementSearchEvidence(discovery,{query:'visitor policy',maxChars:24000,maxPages:1,read:async(url,_query,limit)=>page(url,content.slice(0,limit))}))
  assert.equal(output.pages[0].content,content)
  assert.match(output.pages[0].content,/Visitors require a paid plan/)
})

test('focused discovery keeps a short policy document and its later role restrictions together',async()=>{
  const content='## Member roles\n\n'+('Free plan members can administer workspace settings.\n\n'.repeat(120))+'## Guests\n\nGuest accounts require a paid plan.'
  const profile=retrievalProfile('fact_lookup')
  const output=JSON.parse(await supplementSearchEvidence(discovery,{query:'free plan member limits guests',maxChars:profile.excerptChars,maxPages:profile.excerptPages,
    read:async(url,query,limit)=>JSON.stringify({ok:true,final_url:url,...queryWindow(content,query,limit,0)}),
  }))
  assert.equal(output.pages[0].content,content)
  assert.match(output.pages[0].content,/Guest accounts require a paid plan/)
})

test('a failed page does not hide an independently fetched source', async () => {
  const result = JSON.parse(await supplementSearchEvidence(discovery, {query: 'evidence', read: async url => {
    if (url.includes('one.example')) throw Error('not available')
    return page(url)
  }}))
  assert.equal(result.pages[0].ok, false)
  assert.equal(result.pages[1].ok, true)
  assert.equal(result.results.length, 3)
})

test('the short excerpt deadline cancels the underlying readers', async () => {
  let aborted = 0
  const result = JSON.parse(await supplementSearchEvidence(discovery, {query: 'evidence', deadlineMs: 15, read: async (_url, _query, _max, signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => { aborted++; reject(Error('stopped')) }, {once: true}))
  }))
  assert.equal(aborted, 2)
  assert.ok(result.pages.every((value: {ok: boolean}) => !value.ok))
  assert.equal(result.evidence_status, 'discovery_only')
})

test('discovery-only requests and empty searches issue no page reads', async () => {
  const read = async () => { throw Error('must not be called') }
  assert.equal(await supplementSearchEvidence(discovery, {query: 'evidence', includeContent: false, read}), discovery)
  const empty = '{"results":[]}'
  assert.equal(await supplementSearchEvidence(empty, {query: 'evidence', read}), empty)
})

test('user cancellation propagates instead of returning cached-looking empty evidence', async () => {
  const controller = new AbortController()
  const running = supplementSearchEvidence(discovery, {query: 'evidence', signal: controller.signal, read: async (_url, _query, _max, signal) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('stopped')), {once: true}))
  })
  controller.abort()
  await assert.rejects(running)
})


test('related results are retained as leads without expanding them into irrelevant page text', async () => {
  const readURLs: string[] = []
  const result = JSON.parse(await supplementSearchEvidence(JSON.stringify({results: [
    {url: 'https://source.example/reference', match: {confidence: 'direct'}},
    {url: 'https://unrelated.example/project', match: {confidence: 'lead'}},
  ]}), {query: 'evidence', read: async url => { readURLs.push(url); return page(url) }}))
  assert.deepEqual(readURLs, ['https://source.example/reference'])
  assert.equal(result.results.length, 2)
})


test('an exhausted overall search deadline does not start speculative page reads', async () => {
  let called = false
  const output = await supplementSearchEvidence(discovery, {query:'source',deadlineMs:0,read:async url => {called=true; return page(url)}})
  assert.equal(output, discovery)
  assert.equal(called, false)
})

test('a second strongly matching article is read even without a primary-domain match', async () => {
  const urls:string[]=[]
  const result=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:[
    {url:'https://one.example/article',match:{confidence:'lead',term_coverage:0.8,matched_terms:4}},
    {url:'https://two.example/article',match:{confidence:'lead',term_coverage:0.75,matched_terms:3}},
    {url:'https://unrelated.example/article',match:{confidence:'lead',term_coverage:0.1,matched_terms:1}},
  ]}),{query:'specific evidence',read:async url=>{urls.push(url);return page(url)}}))
  assert.deepEqual(urls,['https://one.example/article','https://two.example/article'])
  assert.equal(result.pages.length,2)
})

test('a completely read source is not fetched again and unopened evidence remains available', async () => {
  const called:string[]=[]
  const output=JSON.parse(await supplementSearchEvidence(discovery,{query:'source',alreadyReadUrls:new Set(['https://one.example/reference']),read:async url=>{called.push(url);return page(url)}}))
  assert.deepEqual(called,['https://two.example/reference'])
  assert.deepEqual(output.previously_read_sources,['https://one.example/reference'])
  assert.equal(output.pages[0].ok,true)
  assert.equal(output.results.length,3)
})


test('a blocked primary source does not leave a matching alternative unread in the same batch', async () => {
  const started:string[]=[]
  const result=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:[
    {url:'https://product.test/pricing',match:{confidence:'direct',subject_match:true}},
    {url:'https://reference.test/product',match:{confidence:'lead',subject_match:true,term_coverage:0.25,matched_terms:1}},
  ]}),{query:'product free plan',read:async url=>{
    started.push(url)
    if(url.startsWith('https://product.test/'))throw Error('HTTP 403')
    return page(url,'The product offers a free tier.')
  }}))
  assert.deepEqual(started,['https://product.test/pricing','https://reference.test/product'])
  assert.equal(result.pages[0].ok,false)
  assert.equal(result.pages[1].ok,true)
  assert.equal(result.evidence_status,'page_excerpts')
  assert.match(result.pages[1].content,/free tier/)
})

test('excerpt slots reach a different matching source before another primary subdomain', async () => {
  const started:string[]=[]
  await supplementSearchEvidence(JSON.stringify({results:[
    {url:'https://product.test/pricing',match:{confidence:'direct',subject_match:true}},
    {url:'https://social.product.test/',match:{confidence:'direct',subject_match:true}},
    {url:'https://reference.test/product',match:{confidence:'lead',subject_match:true}},
  ]}),{query:'product free plan',maxPages:2,read:async url=>{started.push(url);return page(url)}})
  assert.deepEqual(started,['https://product.test/pricing','https://reference.test/product'])
})

test('a shared batch reads bounded ranked sources while keeping every unselected lead', async () => {
  const leads=Array.from({length:6},(_,i)=>({url:`https://source-${i}.test/page`,match:{confidence:'direct'}}))
  const called:string[]=[]
  const output=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:leads}),{query:'subject',maxPages:3,preserveRanking:true,read:async url=>{
    called.push(url)
    if(url===leads[0].url)throw Error('Source blocked')
    return page(url,'Complete conditions: paid plan required.')
  }}))
  assert.deepEqual(called,leads.slice(0,3).map(lead=>lead.url))
  assert.deepEqual(output.results,leads)
  assert.equal(output.pages.filter((p:any)=>p.ok).length,2)
  assert.match(output.pages[1].content,/paid plan required/)
})

test('primary discovery follows a more specific same-site resource without another model turn', async () => {
  const old='https://publisher.test/atlas',exact='https://publisher.test/atlas-3-1017'
  const called:string[]=[]
  const output=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:[{url:old,match:{confidence:'direct'}}]}),{
    query:'Atlas 3 1017 license',refinePrimary:true,read:async url=>{
      called.push(url)
      return JSON.stringify({...JSON.parse(page(url)),title:url===old?'Atlas':'Atlas 3 1017 license',content:url===old?'Older release uses a different license.':'Atlas 3 1017 uses MIT. Attribution required.',outbound_links:url===old?[{url:exact,title:'Atlas 3 1017 license'}]:[]})
    },
  }))
  assert.deepEqual(called,[old,exact])
  assert.equal(output.pages[0].final_url,exact)
  assert.equal(output.pages[0].requested_url,exact)
  assert.equal(output.pages[0].discovered_from,old)
  assert.equal(output.pages[0].content,'Atlas 3 1017 uses MIT. Attribution required.')
  assert.equal(output.results[0].url,old)
})

test('benchmark discovery follows an observed results document and retains its test limits', async () => {
  const root = 'https://forge.test/team/atlas-v3-1077'
  const target = `${root}/results.md`
  const calls: string[] = []
  const evidence = '| Parallel requests | Throughput |\n| --- | --- |\n| 1 | 20 |\n| 4 | 31 |\nOnly these two levels were tested; this is not a capacity limit.'
  const output = JSON.parse(await supplementSearchEvidence(JSON.stringify({ results: [{ url: root, match: { subject_match: true } }] }), {
    query: 'Atlas v3 1077 benchmark', refinePrimary: true,
    read: async url => {
      calls.push(url)
      return JSON.stringify({ ok: true, final_url: url, title: 'Atlas v3 1077', content: url === target ? evidence : 'Installation instructions.',
        outbound_links: url === root ? [{ url: target, title: 'Measured results' }] : [] })
    },
  }))
  assert.deepEqual(calls, [root, target])
  assert.equal(output.pages[0].content, evidence)
  assert.equal(output.pages[0].discovered_from, root)
})

test('linked refinement stays one hop and preserves original evidence after a failed read',async()=>{
  const old='https://publisher.test/atlas',exact='https://publisher.test/atlas-3-1017'
  for(const fail of [true,false]){
    const called:string[]=[]
    const output=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:[{url:old,match:{confidence:'direct'}}]}),{
      query:'Atlas 3 1017 license',refinePrimary:true,read:async url=>{
        called.push(url)
        if(url===exact&&fail)throw Error('Unavailable')
        return JSON.stringify({...JSON.parse(page(url)),title:url===old?'Atlas':'Atlas 3 1017 license',outbound_links:[
          {url:'https://other.test/atlas-3-1017',title:'Atlas 3 1017 license'},
          {url:exact,title:'Atlas 3 1017 license'},
        ]})
      },
    }))
    assert.deepEqual(called,[old,exact])
    assert.equal(output.pages[0].final_url,fail?old:exact)
    assert.equal(output.pages[0].content,'Source evidence')
  }
})

test('each excerpt can resolve an exact linked revision even when generic title words tie the score',async()=>{
  const other='https://other.test/atlas-3',old='https://publisher.test/atlas-3-vs-orion-5',exact='https://publisher.test/atlas-3-1017-vs-orion-5'
  const called:string[]=[]
  const output=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:[other,old].map(url=>({url,match:{confidence:'direct'}}))}),{
    query:'Atlas 3 1017 vs Orion 5 benchmark',refinePrimary:true,read:async url=>{
      called.push(url)
      return JSON.stringify({...JSON.parse(page(url)),title:url===old?'Atlas 3 vs Orion 5 benchmark':'Atlas 3',outbound_links:url===old?[{url:exact,title:'Atlas 3 1017 vs Orion 5'}]:[]})
    },
  }))
  assert.deepEqual(called,[other,old,exact])
  assert.equal(output.pages[1].discovered_from,old)
  assert.equal(output.pages[1].final_url,exact)
})

test('a batched query can refine a path by adding its missing qualifier without losing the existing subject',async()=>{
  const old='https://publisher.test/atlas-3-vs-orion-5',exact='https://publisher.test/atlas-3-1017-vs-orion-5'
  const output=JSON.parse(await supplementSearchEvidence(JSON.stringify({results:[{url:old,match:{confidence:'direct'}}]}),{
    query:'Atlas 3 Orion 5 benchmark comparison Atlas 3 1017 发布 基准测试 Orion 5 发布 评测',refinePrimary:true,read:async url=>JSON.stringify({
      ...JSON.parse(page(url)),title:'Atlas 3 vs Orion 5 benchmark',outbound_links:url===old?[{url:exact,title:'Atlas 3 1017 vs Orion 5'}]:[],
    }),
  }))
  assert.equal(output.pages[0].final_url,exact)
})


test('source reads start while other discovery is pending and final selection stays authoritative',async()=>{
  const started:string[]=[]
  let finish!:()=>void
  const ready=new Promise<void>(resolve=>{finish=resolve})
  const ahead=createSearchReadAhead({query:'source',maxChars:3000,maxPages:2,read:async url=>{
    started.push(url);await ready;return page(url)
  }})
  try{
    ahead.prime(discovery)
    assert.deepEqual(started,['https://one.example/reference'])
    ahead.prime(JSON.stringify({results:[{url:'https://unused.example/reference'}]}))
    ahead.prime(JSON.stringify({results:[{url:'https://over-limit.example/reference'}]}))
    assert.equal(started.length,2)
    finish()
    const out=JSON.parse(await supplementSearchEvidence(discovery,{query:'source',read:ahead.read}))
    assert.deepEqual(out.pages.map((p:any)=>p.final_url),['https://one.example/reference','https://two.example/reference'])
    assert.equal(started.filter(url=>url==='https://one.example/reference').length,1)
    assert.equal(out.results.length,3)
  }finally{ahead.dispose()}
})

test('failed read-ahead is retried by normal reading and unused reads are cancelled',async()=>{
  let attempts=0,aborted=false
  const ahead=createSearchReadAhead({query:'source',maxChars:3000,read:async(url,_q,_n,signal)=>{
    if(url.includes('unused'))return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'))},{once:true}))
    if(attempts++===0)throw Error('Transient failure')
    return page(url)
  }})
  ahead.prime(discovery)
  ahead.prime(JSON.stringify({results:[{url:'https://unused.example/reference'}]}))
  const out=JSON.parse(await ahead.read('https://one.example/reference','source',3000,new AbortController().signal))
  assert.equal(out.ok,true)
  assert.equal(attempts,2)
  ahead.dispose()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(aborted,true)
})


test('a slow source recovery cannot hold up a successful independent source beyond its shared window',async()=>{
  let aborted=false
  const slow=withSourceReadWindow(20,undefined,async signal=>{
    await new Promise(resolve=>setTimeout(resolve,10))
    return new Promise<string>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'))},{once:true}))
  })
  const results=await Promise.allSettled([slow,withSourceReadWindow(20,undefined,async()=>page('https://source.test','Complete source evidence'))])
  assert.equal(results[0].status,'rejected')
  assert.equal(results[1].status,'fulfilled')
  assert.equal(aborted,true)
})
