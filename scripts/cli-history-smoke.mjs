import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import * as pty from 'node-pty'
import assert from 'node:assert/strict'
const root=await mkdtemp(join(tmpdir(),'shun-activity-smoke-'))
const fixture=join(root,'fixture.ts')
await writeFile(fixture,'import { runTui } from \'TUI_MODULE\'\nconst task = { id: \'fixture\', title: \'Activity layout\', workspace: \'\', model: \'test\', providerId: \'test\' }\nconst turns = Array.from({length:60}, (_,i) => ({id:String(i),role:i%2 ? \'assistant\' : \'user\',content:\'Message \' + i}))\nawait runTui(async method => {\n if(method===\'configuration\') return {providers:[{id:\'test\'}],model:\'test\'}\n if(method===\'task.snapshot\') return {task,turns,sequence:0}\n if(method===\'task.events\') return {task,events:[]}\n throw Error(method)\n},{taskId:\'fixture\'})\n'.replace('TUI_MODULE',pathToFileURL(resolve('src/cli/tui.ts')).href))
const terminal=pty.spawn(process.execPath,['--experimental-strip-types',fixture],{cols:100,rows:35,env:{...process.env,TERM:'xterm-256color'}})
let output='';terminal.onData(data=>output+=data)
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,30))}throw Error(output)}
try {
await until(()=>output.includes('Message 59'))
assert.ok(!output.includes('Message 0'))
assert.ok(!output.includes('Message 35'))
// Scroll the bounded transcript to the earlier-message control.
for(let i=0;i<35;i++) { terminal.write('\x1b[<64;6;5M'); await new Promise(r=>setTimeout(r,5)) }
await new Promise(r=>setTimeout(r,150))
// Active compact header occupies two rows; earlier-message control follows.
const screen = output.slice(output.lastIndexOf('\x1b[3J')+4).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
const row = screen.split(/\r?\n/).findIndex(line=>line.includes('36 hidden'))+1;
assert.ok(row>0);
output='';terminal.write(`\x1b[<0;6;${row}M`)
await until(()=>output.includes('12 hidden'))
assert.ok(!output.includes('Message 0'))
console.log('PASS: long conversation renders 24 messages initially and expands one 24-message page on click.')
} finally {terminal.kill(); await rm(root,{recursive:true,force:true})}
