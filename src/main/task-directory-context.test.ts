import assert from 'node:assert/strict'
import test from 'node:test'
import { createTaskDirectoryContextExtension, taskDirectoryPrompt } from './task-directory-context.ts'

test('only generated trailing directory metadata is normalized, preserving instructions and paths',()=>{
  const cwd='/private/task/one',body=`Instructions: read ${cwd}/input.csv.\n<project_instructions path="${cwd}/AGENTS.md">Keep this text.</project_instructions>`
  const prompt=`${body}\nCurrent working directory: ${cwd}\n`
  const projected=taskDirectoryPrompt(prompt,cwd)
  assert.ok(projected.startsWith(body))
  assert.ok(projected.endsWith('Current working directory: . (All relative tool paths resolve in this task’s working directory.)\n'))
  assert.equal(taskDirectoryPrompt(prompt,'/another/task'),prompt)
  assert.equal(taskDirectoryPrompt(`${prompt}Additional instructions`,cwd),`${prompt}Additional instructions`)
  assert.equal(taskDirectoryPrompt('Example: Current working directory: /private/task/one',cwd),'Example: Current working directory: /private/task/one')
})

test('separate private task directories yield the same shared instruction prefix',()=>{
  const one=taskDirectoryPrompt('Instructions\nCurrent working directory: /private/one','/private/one')
  const two=taskDirectoryPrompt('Instructions\nCurrent working directory: /private/two','/private/two')
  assert.equal(one,two)
  assert.equal(taskDirectoryPrompt('Instructions\nCurrent working directory: C:/tasks/one','C:\\tasks\\one'),one)
})

test('selected project context stays unchanged and private task normalization leaves cwd untouched',()=>{
  for(const projectless of [false,true]){
    let handler:any
    createTaskDirectoryContextExtension(projectless)({on:(_event:string,callback:any)=>{handler=callback}} as any)
    const context={cwd:'/private/task'},event={systemPrompt:'Instructions\nCurrent working directory: /private/task'}
    const output=handler(event,context)
    assert.equal(context.cwd,'/private/task')
    assert.equal(event.systemPrompt,'Instructions\nCurrent working directory: /private/task')
    if(projectless)assert.match(output.systemPrompt,/Current working directory: \./)
    else assert.equal(output,undefined)
  }
})
