import {readFile,writeFile,mkdir,mkdtemp,readdir} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join,resolve,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {Readable} from 'node:stream'
const require=createRequire(import.meta.url)
// Uses the real desktop composer, configured model and live web tools.
// Usage: SHUN_BENCHMARK_PLAYWRIGHT=/path/to/playwright node scripts/benchmark-lookup-desktop.mjs 'Question' 'Follow-up'
const {_electron}=require(process.env.SHUN_BENCHMARK_PLAYWRIGHT || 'playwright')
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
if (!process.argv.slice(2).length) throw Error('Provide at least one lookup question.')
const directory=await mkdtemp(join(tmpdir(),'shun-ui-lookup-')),userData=join(directory,'user'),home=join(directory,'home')
await mkdir(userData,{recursive:true});await mkdir(home,{recursive:true})
const saved=JSON.parse(await readFile(process.env.SHUN_BENCHMARK_STATE || join(homedir(),'Library/Application Support/shun/state.json'),'utf8'))
const model=process.env.SHUN_BENCHMARK_MODEL || saved.settings.model,provider=saved.settings.providers.find(p=>p.models?.some(m=>m.id===model)),selected=provider.models.find(m=>m.id===model)
const settings={...saved.settings,contextWindow:selected.contextWindow,maxTokens:selected.maxOutputTokens,model,providerId:provider.id,endpoint:provider.endpoint,apiKey:provider.apiKey||saved.settings.apiKey,workspace:''}
if(process.env.SHUN_BENCHMARK_REASONING)settings.reasoningEffort=process.env.SHUN_BENCHMARK_REASONING
let captureServer,workingDirectoryRewrites=0
if(process.env.SHUN_BENCHMARK_CAPTURE==='1'||process.env.SHUN_BENCHMARK_STABLE_CWD==='1'){
 const upstream=new URL(provider.endpoint)
 let requestNumber=0
 captureServer=createServer(async(req,res)=>{
  const controller=new AbortController()
  req.on('aborted',()=>controller.abort())
  res.on('close',()=>{if(!res.writableFinished)controller.abort()})
  try{
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   let body=Buffer.concat(chunks)
   if(process.env.SHUN_BENCHMARK_STABLE_CWD==='1'&&req.url.includes('/chat/completions')){
    const payload=JSON.parse(body.toString())
    for(const message of payload.messages||[])if(['system','developer'].includes(message.role)&&typeof message.content==='string')message.content=message.content.replace(/^Current working directory: [^\n]+$/gm,()=>{workingDirectoryRewrites++;return 'Current working directory: . (All relative tool paths resolve in this task’s working directory.)'})
    body=Buffer.from(JSON.stringify(payload))
   }
   if(req.url.includes('/chat/completions'))await writeFile(join(directory,`request-${++requestNumber}.json`),body,{mode:0o600})
   const headers={...req.headers};delete headers.host;delete headers.connection;delete headers['content-length']
   const response=await fetch(new URL(req.url,upstream.origin),{method:req.method,headers,body:body.length?body:undefined,signal:controller.signal})
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'application/json'})
   if(response.body){const stream=Readable.fromWeb(response.body);stream.on('error',()=>res.destroy());stream.pipe(res)}else res.end()
  }catch{if(res.headersSent)res.destroy();else{res.writeHead(502);res.end('Benchmark capture transport failed.')}}
 })
 await new Promise(resolve=>captureServer.listen(0,'127.0.0.1',resolve))
 const endpoint=`http://127.0.0.1:${captureServer.address().port}${upstream.pathname}`
 settings.endpoint=endpoint
 settings.providers=settings.providers.map(p=>p.id===provider.id?{...p,endpoint}:p)
}
let replayTask
if(process.env.SHUN_BENCHMARK_REPLAY_TASK){
 const original=saved.tasks.find(t=>t.id===process.env.SHUN_BENCHMARK_REPLAY_TASK)
 if(!original)throw Error('Replay task not found.')
 const question=process.argv[2],turnIndex=original.turns.findLastIndex(t=>t.role==='user'&&(t.text??t.content)===question)
 if(turnIndex<0)throw Error('Replay boundary not found.')
 replayTask={...original,turns:original.turns.slice(0,turnIndex),attachments:[]}
 const sessionRoot=join(homedir(),'.shun/sessions')
 const file=(await readdir(sessionRoot)).find(f=>f.endsWith(`_${original.id}.jsonl`))
 const rows=(await readFile(join(sessionRoot,file),'utf8')).trim().split('\n').map(l=>JSON.parse(l))
 const boundary=rows.findLastIndex(r=>r.type==='message'&&r.message.role==='user'&&r.message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')===question)
 if(boundary<0)throw Error('Native replay boundary not found.')
 await mkdir(join(home,'sessions'),{recursive:true})
 await writeFile(join(home,'sessions',file),rows.slice(0,boundary).map(r=>JSON.stringify(r)).join('\n')+'\n',{mode:0o600})
}
await writeFile(join(userData,'state.json'),JSON.stringify({settings,tasks:replayTask?[replayTask]:[]}),{mode:0o600})
const app=await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env:{...process.env,SHUN_USER_DATA:userData,SHUN_HOME:home}})
console.log(JSON.stringify({directory,pid:app.process().pid,entry:'desktop composer'}))
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),results=[]
try{
 const window=await app.firstWindow(),composer=window.locator('.composer textarea')
 await composer.waitFor({state:'visible',timeout:30000})
 for(const question of process.argv.slice(2)){
  if(results.length && process.env.SHUN_BENCHMARK_FRESH_TASKS==='1') await window.locator('.sidebar button.new').click()
  await composer.fill(question)
  const start=Date.now();await composer.press('Enter')
  let events=[],terminal,taskId,runId
  for(let i=0;i<360;i++){
   const files=await readdir(join(userData,'task-events')).catch(()=>[])
   events=[]
   for(const file of files.filter(f=>f.endsWith('.jsonl'))){
    const rows=(await readFile(join(userData,'task-events',file),'utf8')).trim().split('\n').filter(Boolean).flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}}).filter(r=>r.at>=start && r.payload.type==='agent')
    events.push(...rows)
   }
   events.sort((a,b)=>a.at-b.at);runId=events[0]?.payload.runId;taskId=events[0]?.taskId
   events=events.filter(r=>r.payload.runId===runId)
   terminal=events.find(r=>['done','error','cancelled'].includes(r.payload.event?.type))
   if(terminal)break
   await sleep(500)
  }
  if(terminal) await window.locator('.composer .send.stop').waitFor({state:'hidden',timeout:10000})
  const renderedElapsedMs=Date.now()-start
  const answer=events.filter(r=>r.payload.event?.type==='delta').map(r=>r.payload.event.text||'').join('')
  const tools=[...new Map(events.filter(r=>r.payload.event?.tool?.state==='done').map(r=>[r.payload.event.tool.id,r.payload.event.tool])).values()]
  if(replayTask&&taskId!==replayTask.id)throw Error('Replay did not resume the seeded task.')
  const row={question,stableWorkingDirectoryExperiment:process.env.SHUN_BENCHMARK_STABLE_CWD==='1',workingDirectoryRewrites,reasoningEffort:settings.reasoningEffort||'medium',replayHistory:!!replayTask,freshTask:process.env.SHUN_BENCHMARK_FRESH_TASKS==='1'||!results.length,taskId,runId,renderedElapsedMs,elapsedMs:terminal?terminal.at-start:Date.now()-start,status:terminal?.payload.event.type||'timeout',answer,hasAnswer:!!answer.trim(),hasCitations:/\]\(https?:\/\//.test(answer),qualityReviewed:false,tools:tools.map(t=>{let receipt;try{receipt=JSON.parse(t.output)}catch{};const updates=events.filter(r=>r.payload.event?.tool?.id===t.id);return {name:t.name,input:t.input,elapsedMs:updates.at(-1).at-updates[0].at,...(receipt?.retrieval_timing?{retrievalTiming:receipt.retrieval_timing,retrievalCached:receipt.research?.cached===true}:{})}}),timings:(await readFile(join(home,'request-timing.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)).filter(r=>r.runId===runId)}
  await window.screenshot({path:join(directory,`answer-${results.length+1}.png`)})
  results.push(row);await writeFile(join(directory,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(row))
  if(!terminal) {
    const stop=window.locator('.composer .send.stop')
    if(await stop.count()) await stop.click()
    break
  }
 }
}finally{await app.close();if(captureServer){captureServer.closeAllConnections();await new Promise(resolve=>captureServer.close(resolve))}console.log(JSON.stringify({report:join(directory,'results.json')}))}
