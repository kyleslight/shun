import assert from 'node:assert/strict'
import test from 'node:test'
import { lookupExcerptPages, retrievalBatch, retrievalQueries, retrievalUrls } from './web-retrieval-batch.ts'

test('search batches accept a primary query, a queries array, or both without redundant fields', () => {
  assert.deepEqual(retrievalQueries(' first '), ['first'])
  assert.deepEqual(retrievalQueries(undefined, ['first', 'second']), ['first', 'second'])
  assert.deepEqual(retrievalQueries('first', ['first', ' second ']), ['first', 'second'])
  assert.throws(() => retrievalQueries(undefined, [' ']), /at least one/)
  assert.throws(() => retrievalQueries(undefined, Array.from({length:7},(_,i)=>String(i))), /at most six/)
})

test('source batches accept URLs without a redundant primary URL and reject empty targets', () => {
  assert.deepEqual(retrievalUrls(undefined,['https://one.test/','https://two.test/']),['https://one.test/','https://two.test/'])
  assert.deepEqual(retrievalUrls('https://one.test/',['https://one.test/']),['https://one.test/'])
  assert.throws(()=>retrievalUrls(undefined,[]),/non-empty source URL/)
})

test('independent retrievals all start before any must finish and preserve partial source failures', async () => {
  const started: string[] = [], release: Array<() => void> = []
  const result = retrievalBatch('search', ['alpha', 'beta', 'alpha'], async target => {
    started.push(target)
    await new Promise<void>(resolve => release.push(resolve))
    if (target === 'beta') throw Error('source timed out')
    return JSON.stringify({ results: [{ url: 'https://example.com' }], pages: [{ ok: true, content: 'source passage' }] })
  })
  assert.deepEqual(started, ['alpha', 'beta'])
  release.forEach(resolve => resolve())
  const output = JSON.parse(await result)
  assert.equal(output.parallel, true)
  assert.equal(output.pages[0].content, 'source passage')
  assert.equal(output.responses[1].ok, false)
  assert.equal(output.responses[1].error, 'source timed out')
})

test('batch reading retains each URL and passage, while a single target retains its original receipt', async () => {
  const run = async (url: string) => JSON.stringify({ ok: true, requested_url: url, final_url: url, content: url, has_more: false })
  const batch = JSON.parse(await retrievalBatch('read', ['https://a.test', 'https://b.test'], run))
  assert.deepEqual(batch.pages.map((page: { requested_url: string }) => page.requested_url), ['https://a.test', 'https://b.test'])
  assert.equal(await retrievalBatch('read', ['https://a.test'], run), await run('https://a.test'))
})

test('live progress exposes overlapping queries and completes each line with real timings', async () => {
  const snapshots: import('../shared').FanoutProgress[] = []
  const releases: Array<() => void> = []
  const pending = retrievalBatch('search', ['original subject', 'independent variant'], async () => {
    await new Promise<void>(resolve => releases.push(resolve))
    return JSON.stringify({ results: [] })
  }, progress => snapshots.push(progress))
  assert.equal(snapshots[0].unit, 'queries')
  assert.deepEqual(snapshots[0].lines.map(line => line.state), ['running', 'running'])
  releases[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(snapshots.at(-1)!.lines.map(line => line.state), ['done', 'running'])
  releases[1]()
  const output = JSON.parse(await pending)
  assert.equal(snapshots.at(-1)!.running, false)
  assert.equal(snapshots.at(-1)!.done, 2)
  assert.ok(output.responses[1].started_at <= output.responses[0].finished_at)
  assert.ok(output.responses.every((row: { started_at: number; finished_at: number }) => row.finished_at >= row.started_at))
})

test('six independent queries overlap while duplicate sources do not multiply evidence', async () => {
  const started: string[] = [], release: Array<() => void> = []
  const pending = retrievalBatch('search', ['a','b','c','d','e','f'], async target => {
    started.push(target)
    await new Promise<void>(resolve => release.push(resolve))
    return JSON.stringify({results:[{url:'https://example.test/source'}],pages:[{ok:true,requested_url:'https://example.test/source',content:target==='f'?'A different passage.':'The shared passage.'}]})
  })
  assert.equal(started.length,6)
  release.forEach(resolve=>resolve())
  const output=JSON.parse(await pending)
  assert.equal(output.responses.length,6)
  assert.equal(output.results.length,1)
  assert.equal(output.pages.length,2)
})


test('batch evidence selection sees each independent query before redundant lower-ranked leads', async () => {
  const output=JSON.parse(await retrievalBatch('search',['alpha','beta'],async target=>JSON.stringify({results:[1,2,3].map(i=>({url:`https://${target}.test/${i}`}))})))
  assert.deepEqual(output.results.map((r:any)=>r.url),['https://alpha.test/1','https://beta.test/1','https://alpha.test/2','https://beta.test/2','https://alpha.test/3','https://beta.test/3'])
})


test('parallel lookup calls share one excerpt budget without suppressing search leads or explicit research',()=>{
  const calls=Array.from({length:4},(_,i)=>({id:String(i),name:'web_search',arguments:{task_depth:'fact_lookup'}}))
  assert.deepEqual(calls.map(c=>lookupExcerptPages(c.id,calls,3)),[1,1,0,0])
  assert.deepEqual(calls.slice(0,2).map(c=>lookupExcerptPages(c.id,calls.slice(0,2),3)),[1,1])
  assert.equal(lookupExcerptPages('0',calls.slice(0,1),2),2)
  assert.equal(lookupExcerptPages('unrelated',calls,3),3)
  const mixed=[calls[0],{...calls[1],arguments:{task_depth:'deep_research'}}]
  assert.equal(lookupExcerptPages('0',mixed,3),3)
  assert.equal(lookupExcerptPages('1',mixed,3),3)
  const discoveryOnly=[calls[0],{...calls[1],arguments:{task_depth:'fact_lookup',include_content:false}}]
  assert.equal(lookupExcerptPages('0',discoveryOnly,3),3)
})
