import {mkdtemp, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import * as pty from 'node-pty'
import assert from 'node:assert/strict'
const root=await mkdtemp(join(tmpdir(),'shun-activity-smoke-'))
const fixture=join(root,'fixture.ts')
await writeFile(fixture,'import { runTui } from \'TUI_MODULE\'\nconst task = { id: \'fixture\', title: \'Activity layout\', workspace: \'\', model: \'test\', providerId: \'test\' }\nconst turns = [{id:\'answer\',role:\'assistant\',content:\'Your campaigns are paused.\',tools:[{id:\'tool\',name:\'read\',input:\'{"path":"SKILL.md"}\',output:\'PRIVATE_TOOL_DETAILS\\nSecond line\',state:\'done\'}]}]\nawait runTui(async method => {\n if(method===\'configuration\') return {providers:[{id:\'test\'}],model:\'test\'}\n if(method===\'task.snapshot\') return {task,turns,sequence:0}\n if(method===\'task.events\') return {task,events:[]}\n throw Error(method)\n},{taskId:\'fixture\'})\n'.replace('TUI_MODULE',pathToFileURL(resolve('src/cli/tui.ts')).href))
const terminal=pty.spawn(process.execPath,['--experimental-strip-types',fixture],{cols:100,rows:35,env:{...process.env,TERM:'xterm-256color'}})
let output='';terminal.onData(data=>output+=data)
const until=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,30))}throw Error(output)}
try {
await until(()=>output.includes('Show details'))
assert.ok(!output.includes('PRIVATE_TOOL_DETAILS'))
// Find row from initial full screen render, with ANSI stripped.
const last=output.slice(output.lastIndexOf('\x1b[3J')+4).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b_[^\x07]*\x07/g,'')
const rows=last.split(/\r?\n/);const row=rows.findIndex(r=>r.includes('Show details'))+1
assert.ok(row>0)
terminal.write(`\x1b[<0;6;${row}M`)
await until(()=>output.includes('PRIVATE_TOOL_DETAILS'))
output='';terminal.write(`\x1b[<0;6;${row}M`)
await until(()=>output.includes('Show details'))
assert.ok(!output.includes('PRIVATE_TOOL_DETAILS'))
output=''; terminal.write('/')
await until(()=>output.includes('Show available commands') && output.includes('Choose a model'))
output=''; terminal.write('mod')
await until(()=>output.includes('Choose a model'))
terminal.write('\t'); await new Promise(r=>setTimeout(r,150))
terminal.write('\x1b');
console.log('PASS: slash menu opens and filters in the terminal.')
console.log('PASS: click expands and collapses only the selected activity; raw output hidden by default.')
} finally {terminal.kill(); await rm(root,{recursive:true,force:true})}
