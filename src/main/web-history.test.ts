import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebHistoryTool } from './web-history.ts'

const message:any={role:'toolResult',toolCallId:'source-one',toolName:'web_read',timestamp:123,isError:false,
  content:[{type:'text',text:JSON.stringify({ok:true,final_url:'https://publisher.test/plans',content:'Free members. '.repeat(300)+'Guests require a paid plan.'})}]}
const context:any={sessionManager:{getBranch:()=>[{type:'message',message}]}}
const execute=(args:any,ctx=context,signal=new AbortController().signal)=>createWebHistoryTool().execute('read-history',args,signal,undefined,ctx)

test('historical source reads recover exact original conditions and provenance with pagination',async()=>{
  const firstBlock=(await execute({tool_call_id:'source-one',max_chars:1000})).content[0]; assert.equal(firstBlock.type,'text')
  const first=JSON.parse(firstBlock.type==='text'?firstBlock.text:'')
  const restBlock=(await execute({tool_call_id:'source-one',offset_chars:1000,max_chars:24000})).content[0]; assert.equal(restBlock.type,'text')
  const rest=JSON.parse(restBlock.type==='text'?restBlock.text:'')
  assert.equal(first.content+rest.content,message.content[0].text)
  assert.equal(first.has_more,true)
  assert.equal(rest.has_more,false)
  assert.equal(first.original_timestamp,123)
  assert.match(rest.content,/Guests require a paid plan/)
})

test('historical reads are confined to web results in the current native branch',async()=>{
  await assert.rejects(execute({tool_call_id:'other-task'}),/current history/)
  await assert.rejects(execute({tool_call_id:'source-one'},{sessionManager:{getBranch:()=>[]}}),/current history/)
  await assert.rejects(execute({tool_call_id:'source-one'},{sessionManager:{getBranch:()=>[{type:'message',message:{...message,toolName:'read'}}]}}),/current history/)
  const controller=new AbortController();controller.abort()
  await assert.rejects(execute({tool_call_id:'source-one'},context,controller.signal))
})
