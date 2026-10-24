import assert from 'node:assert/strict'
import test from 'node:test'
import { createLookupDeliveryExtension } from './web-lookup-delivery.ts'

function harness(options: Parameters<typeof createLookupDeliveryExtension>[0] = {enabled:true}) {
  const handlers=new Map<string,Function>()
  createLookupDeliveryExtension(options)({on:(name:string,handler:Function)=>handlers.set(name,handler)} as any)
  const context:any={model:{api:'openai-completions'}}
  return {context,fire:(name:string,event:any)=>handlers.get(name)?.(event,context)}
}
function start(h:ReturnType<typeof harness>,question='How many builds are included?') {
  h.fire('before_agent_start',{prompt:question})
  h.fire('message_start',{message:{role:'user',content:[{type:'text',text:question}]}})
}
function lookup(h:ReturnType<typeof harness>,id='lookup',depth='fact_lookup') {
  return h.fire('tool_call',{toolCallId:id,toolName:'web_search',input:{query:'Example plan builds',task_depth:depth}})
}
function source(id='lookup',url='https://publisher.test/plans') {
  return {role:'toolResult',toolCallId:id,content:[{type:'text',text:JSON.stringify({
    results:[{url:'https://unread.test/lead',snippet:'A lead'}],
    pages:[{ok:true,final_url:url,title:'Plan limits',content:'The plan includes 500 builds. [Another page](https://unread.test/linked)'}],
  })}]}
}

test('direct answers do not discover features or change provider requests', async () => {
  let discoveries=0
  const h=harness({enabled:true,resolveReasoningBudget:async()=>{discoveries++;return 'thinking_budget'}})
  start(h)
  assert.equal(await h.fire('context',{messages:[{role:'user',content:[]}]}),undefined)
  const request={messages:[],thinking:{type:'enabled'}}
  assert.equal(await h.fire('before_provider_request',{payload:request}),undefined)
  assert.equal(discoveries,0)
})

test('a selected lookup keeps source content intact and preserves cache-compatible thinking mode', async () => {
  let discoveries=0
  const h=harness({enabled:true,resolveReasoningBudget:async()=>{discoveries++;return 'thinking_budget'}})
  start(h)
  assert.equal(lookup(h),undefined)
  const message=source(),messages=[message]
  const result=await h.fire('context',{messages})
  assert.equal(result.messages[0],message)
  assert.deepEqual(JSON.parse(result.messages[1].content).read_sources,[{url:'https://publisher.test/plans',title:'Plan limits'}])
  assert.equal(messages.length,1)
  const request={messages:[],thinking:{type:'enabled'},reasoning_effort:'medium'}
  assert.deepEqual(await h.fire('before_provider_request',{payload:request}),{...request,thinking_budget:512})
  await h.fire('context',{messages})
  assert.equal(discoveries,1)
})

test('mixed work and explicit investigations retain their normal reasoning', async () => {
  for(const other of [
    {toolCallId:'deep',toolName:'web_read',input:{task_depth:'deep_research',url:'https://publisher.test/details'}},
    {toolCallId:'edit',toolName:'edit',input:{path:'example.ts'}},
  ]){
    let discoveries=0
    const h=harness({enabled:true,resolveReasoningBudget:async()=>{discoveries++;return 'thinking_budget'}})
    start(h)
    h.fire('tool_call',other)
    lookup(h)
    assert.equal(await h.fire('context',{messages:[source()]}),undefined)
    assert.equal(await h.fire('before_provider_request',{payload:{messages:[]}}),undefined)
    assert.equal(discoveries,0)
  }
})

test('unknown or unavailable endpoint capabilities leave the request unchanged', async () => {
  for(const resolver of [async()=>undefined,async()=>{throw Error('metadata unavailable')}]){
    const h=harness({enabled:true,resolveReasoningBudget:resolver})
    start(h);lookup(h)
    assert.ok(await h.fire('context',{messages:[source()]}))
    const request={messages:[],thinking:{type:'enabled'},reasoning_effort:'high'}
    assert.equal(await h.fire('before_provider_request',{payload:request}),request)
  }
})

test('new user steering withdraws the old delivery phase without blocking tools', async () => {
  const h=harness({enabled:true,resolveReasoningBudget:async()=> 'thinking_budget'})
  start(h);lookup(h)
  await h.fire('context',{messages:[source()]})
  h.fire('message_start',{message:{role:'user',content:[{type:'text',text:'Now inspect a different request.'}]}})
  assert.equal(await h.fire('context',{messages:[source()]}),undefined)
  assert.equal(await h.fire('before_provider_request',{payload:{messages:[]}}),undefined)
  assert.equal(lookup(h,'another'),undefined)
})

test('lookup state and source identities stay independent across tasks', async () => {
  const a=harness({enabled:true,resolveReasoningBudget:async()=> 'thinking_budget'}),b=harness()
  start(a,'First question');start(b,'Second question')
  lookup(a,'one')
  const answer=await a.fire('context',{messages:[source('one','https://first.test/source')]})
  assert.equal(JSON.parse(answer.messages[1].content).original_question,'First question')
  assert.equal(await b.fire('context',{messages:[source('one')]}),undefined)
  a.fire('agent_end',{})
  assert.equal(await a.fire('before_provider_request',{payload:{messages:[]}}),undefined)
})
