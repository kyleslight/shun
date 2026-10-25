import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createCanvas } from '@napi-rs/canvas'
import * as pty from 'node-pty'
import { ShunHostService } from '../src/host/service.ts'
import { startHostServer } from '../src/host/transport.ts'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'shun-interface-'))
const workspace = join(temporary, 'workspace'), home = join(temporary, 'home')
await mkdir(workspace)
const requests = [], imageCounts = []
const service = new ShunHostService(home, async (req, signal, emit, options) => {
  requests.push(req)
  imageCounts.push(options.initialImages?.length || 0)
  emit({ id: req.id, type: 'delta', text: 'The task is running in the shared service. Both interfaces see the same progress.' })
  await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
  emit({ id: req.id, type: 'cancelled' })
})
let host, terminal, desktop
const waitFor = async (check, timeout = 15000) => {
  const start = Date.now()
  while (!await check()) { if (Date.now() - start > timeout) throw Error('Interface smoke check timed out.'); await new Promise(resolve => setTimeout(resolve, 100)) }
}
try {
  host = await startHostServer(home, service)
  const config = await service.call('provider.save', { name: 'Local test connection', endpoint: 'http://127.0.0.1:19999/v1' })
  await service.call('model.select', { providerId: config.providers[0].id, model: 'test-vision-model' })
  const task = await service.call('task.create', { workspace })
  await service.call('task.rename', { taskId: task.id, title: 'Shared image conversation' })
  const otherTask = await service.call('task.create', { workspace })
  await service.call('task.rename', { taskId: otherTask.id, title: 'Other task' })
  const canvas = createCanvas(240, 100), ctx = canvas.getContext('2d')
  ctx.fillStyle = '#efefef'; ctx.fillRect(0, 0, 240, 100); ctx.fillStyle = '#222'; ctx.font = '20px sans-serif'; ctx.fillText('Shun image attachment', 12, 55)
  const png = canvas.toBuffer('image/png').toString('base64')
  const clipboardFixture = join(temporary, 'clipboard.cjs')
  // Replace only the native module inside this test child. The user's real
  // system clipboard is never read or changed by the interface smoke test.
  const clipboardPackages = { 'darwin-arm64': '@mariozechner/clipboard-darwin-arm64', 'darwin-x64': '@mariozechner/clipboard-darwin-x64', 'linux-x64': '@mariozechner/clipboard-linux-x64-gnu', 'win32-x64': '@mariozechner/clipboard-win32-x64-msvc' }
  const clipboardModule = require.resolve(clipboardPackages[`${process.platform}-${process.arch}`])
  await writeFile(clipboardFixture, `const clipboard=require(${JSON.stringify(clipboardModule)});clipboard.hasImage=()=>true;clipboard.getImageBinary=async()=>[...Buffer.from(${JSON.stringify(png)},'base64')];`)
  let terminalOutput = ''
  terminal = pty.spawn(process.execPath, ['--require', clipboardFixture, join(root, 'packages/shun/bin/shun.mjs'), '--task', task.id], { cols: 110, rows: 32, cwd: workspace, env: { ...process.env, SHUN_HOME: home, TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', SSH_CONNECTION: '', SSH_TTY: '' } })
  terminal.onData(data => { terminalOutput += data })
  await waitFor(() => terminalOutput.includes('Shared image conversation'))
  terminal.write('\x16')
  await waitFor(() => terminalOutput.includes('Attached Screenshot-'))
  terminal.write('\x1b[200~你好 Shun\nThis is a pasted second line.\x1b[201~')
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(requests.length, 0, 'bracketed paste must not submit a message')
  terminal.write('\r')
  await waitFor(() => requests.length === 1)
  assert.equal(requests[0].text, '你好 Shun\nThis is a pasted second line.')
  assert.equal(imageCounts[0], 1, 'Ctrl+V must send an actual image to the shared session')
  terminal.write('\x04')
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(service.runs.get(task.id), 'detaching the terminal must leave the run alive')

  const screenshot = join(tmpdir(), 'shun-shared-workspace.png')
  const harness = join(temporary, 'desktop.cjs')
  const token = (await readFile(service.paths.token, 'utf8')).trim()
  await writeFile(harness, `
const {app,BrowserWindow,ipcMain}=require('electron');
const {request}=require('node:http');
const {writeFileSync}=require('node:fs');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(join(temporary, 'electron'))});
ipcMain.handle('host:call',(_event,method,input)=>new Promise((resolve,reject)=>{const req=request({socketPath:${JSON.stringify(service.paths.socket)},path:'/rpc',method:'POST',headers:{authorization:${JSON.stringify(`Bearer ${token}`)}}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{const value=JSON.parse(raw);const done=()=>value.ok?resolve(value.result):reject(Error(value.error));method==='task.send'&&input.text==='Race message'?setTimeout(done,1000):done()})});req.on('error',reject);req.end(JSON.stringify({method,input}))}));
app.whenReady().then(async()=>{const win=new BrowserWindow({width:1180,height:800,show:false,webPreferences:{preload:${JSON.stringify(join(root, 'out/preload/index.cjs'))},sandbox:true,contextIsolation:true,nodeIntegration:false}});
const run=code=>win.webContents.executeJavaScript(code);
const until=async code=>{for(let i=0;i<100;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,100))}throw Error('Desktop check timed out: '+code)};
try{await win.loadFile(${JSON.stringify(join(root, 'out/renderer/index.html'))},{query:{host:'local',task:${JSON.stringify(task.id)}}});
await until("document.body.innerText.includes('Both interfaces see the same progress')");
await run("document.querySelector('textarea').value='Desktop draft';document.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true}))");
await new Promise(r=>setTimeout(r,700));
assert.equal(await run("document.querySelector('textarea').value"),'Desktop draft');
await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Stop').click()");
await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Send')");
await run(${JSON.stringify(`const bytes=Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'Screenshot.png',{type:'image/png'}));document.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true}));`)});
await until("document.querySelectorAll('.host-composer .host-attachment').length===1");
await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Send').click()");
await until("document.body.innerText.includes('Desktop draft') && document.querySelector('textarea').value===''");
await new Promise(r=>setTimeout(r,500));
writeFileSync(${JSON.stringify(screenshot)},(await win.webContents.capturePage()).toPNG());
await run("[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes('Other task')).click()");
await until("document.querySelector('.host-toolbar strong').textContent==='Other task'");
await run("document.querySelector('textarea').value='Keep my draft';document.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true}))");
await run("[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes('Shared image conversation')).click()");
await until("document.querySelector('.host-toolbar strong').textContent==='Shared image conversation'");
await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Stop').click()");
await until("[...document.querySelectorAll('button')].some(b=>b.textContent==='Send')");
await run("document.querySelector('textarea').value='Race message';document.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true}))");
await run("[...document.querySelectorAll('button')].find(b=>b.textContent==='Send').click();[...document.querySelectorAll('nav button')].find(b=>b.textContent.includes('Other task')).click()");
await until("document.querySelector('.host-toolbar strong').textContent==='Other task'");
await new Promise(r=>setTimeout(r,1500));
assert.equal(await run("document.querySelector('.host-toolbar strong').textContent"),'Other task');
assert.equal(await run("document.querySelector('textarea').value"),'Keep my draft');
console.log('DESKTOP_SMOKE_OK');win.destroy();app.quit();
}catch(error){console.error(error);app.exit(1)}});
`)
  desktop = spawn(require('electron'), [harness], { cwd: root, env: { ...process.env, SHUN_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  desktop.stdout.on('data', chunk => { output += chunk })
  desktop.stderr.on('data', chunk => { output += chunk })
  const desktopTimeout = setTimeout(() => desktop.kill('SIGKILL'), 30000)
  const exit = await new Promise(resolve => desktop.on('exit', resolve))
  clearTimeout(desktopTimeout)
  assert.equal(exit, 0, output)
  assert.match(output, /DESKTOP_SMOKE_OK/)
  assert.ok(service.runs.get(task.id), 'closing the desktop must leave its run alive')
  assert.equal(requests.length, 3)
  assert.equal((await service.snapshot(task.id)).turns[2].attachments.length, 1)
  console.log(JSON.stringify({ terminal: 'Ctrl+V image attachment, Chinese multiline paste, explicit submit, detach keeps task running', desktop: 'Attach to live task, stop, paste image, send, close keeps task running; late responses cannot select a hidden task or clear the visible draft', screenshot }))
} finally {
  terminal?.kill(); desktop?.kill()
  await host?.close()
  await rm(temporary, { recursive: true, force: true })
}
