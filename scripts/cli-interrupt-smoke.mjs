import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as pty from 'node-pty'
import assert from 'node:assert/strict'
const root = await mkdtemp(join(tmpdir(), 'shun-interrupt-'))
const fixture = join(root, 'fixture.ts')
await writeFile(fixture, `import { runTui } from ${JSON.stringify(pathToFileURL(resolve('src/cli/tui.ts')).href)}
const task = { id: 'existing', title: 'Existing conversation', workspace: '', model: 'test', providerId: 'test' }
let running = true
await runTui(async (method, args) => {
 if (method === 'configuration') return { providers: [{ id: 'test' }], model: 'test' }
 if (method === 'task.create') return { ...task, id: 'new', title: 'New task' }
 if (method === 'task.snapshot') return { task: args.taskId === 'new' ? {...task, id:'new', title:'New task'} : task, turns: args.taskId === 'new' ? [] : [{id:'answer',role:'assistant',content:'Saved answer'}], sequence:0, activeRun: running ? 'run' : undefined }
 if (method === 'task.stop') { running = false; return {} }
 if (method === 'task.events') return { task: args.taskId === 'new' ? {...task, id:'new', title:'New task'} : task, events:[], activeRun: running ? 'run' : undefined }
 throw Error(method)
}, { taskId: 'existing' })
`)
const terminal = pty.spawn(process.execPath, ['--experimental-strip-types', fixture], { cols:100, rows:35, env:{...process.env, TERM:'xterm-256color'} })
let output = '', exited = false
terminal.onData(data => output += data)
terminal.onExit(() => { exited = true })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const until = async predicate => { for (let i=0;i<100;i++) { if(predicate()) return; await delay(30) } throw Error(output) }
try {
 await until(() => output.includes('Saved answer'))
 output = ''; terminal.write('\x03')
 await until(() => output.includes('Stopping'))
 await delay(400)
 assert.equal(exited, false)
 assert.ok(!output.includes('Also available on Desktop'))
 output = ''; terminal.write('\x03')
 await until(() => output.includes('Also available on Desktop'))
 assert.equal(exited, false)
 output = ''; terminal.write('\x03')
 await until(() => output.includes('again to exit'))
 assert.equal(exited, false)
 terminal.write('\x03')
 await until(() => exited)
 console.log('PASS: Ctrl+C stops generation, returns to home, then requires two presses at home to exit.')
} finally { if (!exited) terminal.kill(); await rm(root,{recursive:true,force:true}) }
