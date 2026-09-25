import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { createBrowserSettle } from '../src/main/browser-settle.ts'
import { ChromeBrowserService } from '../src/main/chrome-browser.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = join(root, 'resources', 'browser-use-extension')
const chromeCandidates = process.env.SHUN_CHROME_BINARY ? [process.env.SHUN_CHROME_BINARY] : process.platform === 'darwin'
  ? ['/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
  : process.platform === 'win32'
    ? [
        join(process.env.PROGRAMFILES || '', 'Google', 'Chrome for Testing', 'chrome.exe'),
        join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome for Testing', 'chrome.exe'),
      ]
    : ['/opt/chrome-for-testing/chrome', '/usr/local/bin/chrome-for-testing']
const chrome = chromeCandidates.find(candidate => candidate && existsSync(candidate))

if (!chrome) throw new Error('Chrome was not found. Set SHUN_CHROME_BINARY to a Chrome for Testing executable before running the Browser Use smoke test.')

const profileDir = await mkdtemp(join(tmpdir(), 'shun-browser-use-smoke-'))
const storageFile = join(profileDir, 'shun-data', 'sessions.json')
const service = new ChromeBrowserService(storageFile)
const uploadFile = join(profileDir, 'upload-sample.txt')
const server = createServer((request, response) => {
  if (request.url === '/download') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="download-sample.txt"' })
    response.end('Downloaded by Shun Browser Use')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html><body>
    <h1 id="status">Ready for Shun</h1>
    <button onclick="document.querySelector('#status').textContent = 'Clicked by Shun'">Change heading</button>
    <label>Browser input <input aria-label="Browser input"></label>
    <input type="file" aria-label="Upload sample">
    <span id="upload-proxy" role="button" tabindex="0" aria-label="Choose a file" style="display:inline-block;padding:6px 10px;border:1px solid #888">Choose a file<input type="file" id="upload-hidden" aria-label="Hidden upload" style="display:none"></span>
    <div id="proxy-status">no file chosen</div>
    <div id="sibling-wrapper" style="padding:4px;border:1px dashed #aaa">
      <button id="sibling-proxy" type="button">Choose a file (side by side)</button>
      <input type="file" id="sibling-hidden" aria-label="Sibling upload" style="display:none">
    </div>
    <div id="sibling-status">no file chosen</div>
    <div id="filler"></div>
    <script>
      for (const [inputId, statusId] of [['upload-hidden', 'proxy-status'], ['sibling-hidden', 'sibling-status']]) {
        document.querySelector('#' + inputId).addEventListener('change', (event) => {
          document.querySelector('#' + statusId).textContent = event.target.files && event.target.files[0] ? event.target.files[0].name : 'no file chosen'
        })
      }
      // A page long enough that the first three hundred nodes are all furniture: a control
      // below them must still be reachable in a snapshot, or a visible button a task has to
      // click is simply never mentioned.
      const filler = document.querySelector('#filler')
      for (let index = 0; index < 400; index += 1) {
        const button = document.createElement('button')
        button.textContent = 'Filler control ' + index
        filler.appendChild(button)
      }
    </script>
    <a href="/download">Download sample</a>
  </body></html>`)
})

let chromeProcess
let failed = false
let stderr = ''
let downloadedFile = ''

try {
  await writeFile(uploadFile, 'Uploaded by Shun Browser Use')
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Smoke-test HTTP server did not expose a TCP port.')
  const targetUrl = `http://127.0.0.1:${address.port}/`

  const bridgePort = await service.start()
  const isolatedExtensionDir = join(profileDir, 'browser-use-extension')
  await cp(extensionDir, isolatedExtensionDir, { recursive: true })
  const workerPath = join(isolatedExtensionDir, 'service-worker.js')
  const worker = await readFile(workerPath, 'utf8')
  await writeFile(workerPath, worker.replace("const PORTS = Array.from({ length: 10 }, (_, index) => 32124 + index)", `const PORTS = [${bridgePort}]`))
  const headMode = process.env.SHUN_CHROME_HEADFUL === '1' ? [] : ['--headless=new']
  chromeProcess = spawn(chrome, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${isolatedExtensionDir}`,
    `--disable-extensions-except=${isolatedExtensionDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch,LocalNetworkAccessChecks',
    ...headMode,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--no-proxy-server',
    '--disable-component-update',
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  chromeProcess.stderr.setEncoding('utf8')
  chromeProcess.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000) })

  await waitFor(() => service.state().connected, 20_000, 'Chrome extension did not connect to the Shun loopback bridge.')
  console.log(`connected: bridge port ${bridgePort}`)

  const session = await service.open('browser-smoke-task', 'browser-smoke-run', targetUrl, false)
  let capture = await service.snapshot('browser-smoke-task', session.id, true)
  const button = capture.snapshot.nodes?.find(node => node.role === 'button' && node.name === 'Change heading')
  const input = capture.snapshot.nodes?.find(node => node.role === 'textbox' && node.name === 'Browser input')
  const upload = capture.snapshot.nodes?.find(node => node.name === 'Upload sample')
  const download = capture.snapshot.nodes?.find(node => node.role === 'link' && node.name === 'Download sample')
  const proxy = capture.snapshot.nodes?.find(node => /Choose a file/.test(String(node.name || '')) && node.role === 'button')
  if (!button?.ref || !input?.ref || !upload?.ref || !download?.ref) throw new Error('Chrome accessibility snapshot did not contain the expected interactive refs.')
  if (!capture.snapshot.screenshot || capture.snapshot.screenshot.length < 100) throw new Error('Chrome screenshot capture returned no image data.')
  console.log(`snapshot: ${capture.snapshot.nodes?.length || 0} accessibility nodes and PNG screenshot`)

  capture = await service.act('browser-smoke-task', session.id, { action: 'click', ref: button.ref })
  if (!capture.snapshot.text?.includes('Clicked by Shun')) throw new Error('Chrome click action did not update the page.')
  console.log('click: page state updated')

  capture = await service.act('browser-smoke-task', session.id, { action: 'type', ref: input.ref, text: 'Shun controls Chrome' })
  const updatedInput = capture.snapshot.nodes?.find(node => node.role === 'textbox' && node.name === 'Browser input')
  if (updatedInput?.value !== 'Shun controls Chrome') throw new Error('Chrome type action did not update the input value.')
  console.log('type: input value updated')

  capture = await service.act('browser-smoke-task', session.id, { action: 'upload', ref: upload.ref, files: [uploadFile] })
  const updatedUpload = capture.snapshot.nodes?.find(node => node.name === 'Upload sample')
  if (!String(updatedUpload?.value || '').includes('upload-sample.txt')) throw new Error('Chrome file upload did not update the file input value.')
  console.log('upload: local file attached to form control')

  // The hidden-input pattern of a real upload page: clicking the visible control cannot upload,
  // because a page cannot open a file picker by itself — the click is refused and names the
  // action that does it, and the visible control's own ref is what the upload is set through.
  if (!proxy?.ref) throw new Error('Chrome accessibility snapshot did not contain the visible upload control.')
  let refused
  try { await service.act('browser-smoke-task', session.id, { action: 'click', ref: proxy.ref }) }
  catch (error) { refused = error instanceof Error ? error.message : String(error) }
  if (!/action=upload/.test(String(refused))) throw new Error(`A click on a control that uploads a file was not refused with the upload action: ${refused || 'no refusal'}`)
  console.log('upload proxy: a click was refused and named action=upload')

  capture = await service.act('browser-smoke-task', session.id, { action: 'upload', ref: proxy.ref, files: [uploadFile] })
  // The input is hidden, so the page's own report of what it received is the evidence.
  if (!/upload-sample\.txt/.test(capture.text || '')) throw new Error('Uploading through the visible control did not set the hidden file input underneath it.')
  console.log('upload proxy: the file was set through the visible control')

  // A control below four hundred filler buttons is still in the reading: interactive
  // controls are kept ahead of furniture instead of being truncated by document order.
  // What the model receives is the formatted reading, so that is what has to carry the
  // control: asserting against the raw snapshot would pass on a reading that never mentions it.
  const shown = capture.snapshot.nodes?.length || 0
  if (!/side by side/.test(capture.text || '')) throw new Error(`A control below ${shown} nodes of furniture was not in the reading a model receives.`)
  const sibling = capture.snapshot.nodes?.find(node => /side by side/.test(String(node.name || '')))
  if (!sibling?.ref) throw new Error('The control was in the reading but not addressable.')
  const note = (capture.text.match(/Showing \d+ of \d+ nodes[^\\n]*/) || [])[0]
  console.log(`node cap: the readable control survived a ${shown}-node page${note ? ` — "${note.slice(0, 72)}…"` : ''}`)

  let siblingRefused
  try { await service.act('browser-smoke-task', session.id, { action: 'click', ref: sibling.ref }) }
  catch (error) { siblingRefused = error instanceof Error ? error.message : String(error) }
  if (!/action=upload/.test(String(siblingRefused))) throw new Error(`A click on a control sitting beside its file input was not refused with the upload action: ${siblingRefused || 'no refusal'}`)
  console.log('side-by-side proxy: a click was refused and named action=upload')

  capture = await service.act('browser-smoke-task', session.id, { action: 'upload', ref: sibling.ref, files: [uploadFile] })
  if (!/upload-sample\.txt/.test(capture.text || '')) throw new Error('Uploading through a control that sits beside its input did not set that input.')
  console.log('side-by-side proxy: the file was set through the control beside it')

  const downloaded = await service.download('browser-smoke-task', session.id, download.ref, 20_000)
  downloadedFile = String(downloaded?.filename || '')
  if (downloaded?.state !== 'complete' || !/download-sample(?: \(\d+\))?\.txt$/.test(downloadedFile)) throw new Error('Chrome download did not complete with the expected file.')
  console.log('download: completion and final local filename observed')

  // A run that ends suspends its tab: the debugger stays attached between the steps of one
  // piece of work, which is what keeps Chrome's debugging bar from flickering under the
  // person's hands. The tab is still the task's, so it is still listed.
  await service.releaseRun('browser-smoke-task', 'browser-smoke-run')
  const afterRun = (await service.list('browser-smoke-task'))[0]
  if (afterRun?.state !== 'suspended') throw new Error(`A run that ended left its tab in state ${afterRun?.state || 'gone'} instead of suspending it.`)
  console.log('run release: suspended, tab kept, debugger attached between steps')

  // A task that goes quiet is finished: the debugger comes off, Chrome's bar goes with it, and
  // the tab is the person's again. This is the release that a long-horizon task never used to
  // get, which is why the bar stayed on the tab after the work was done.
  const settle = createBrowserSettle({ release: taskId => service.releaseTask(taskId), quietMs: 50 })
  settle.schedule('browser-smoke-task')
  await waitFor(async () => (await service.list('browser-smoke-task')).length === 0, 5_000, 'A task that went quiet did not release its tab.')
  settle.stop()
  console.log('settle: the quiet task released its tab and detached the debugger')

} catch (error) {
  failed = true
  await printChromeDiagnostics(profileDir)
  if (stderr) console.error(stderr)
  throw error
} finally {
  await service.stop().catch(() => {})
  // The browser goes first. Chrome keeps its connection to this test server alive, and
  // `server.close()` waits for open connections — so closing the server while the browser is
  // still running is the two of them waiting for each other, which is what left a smoke test
  // hanging with a browser still on screen.
  if (chromeProcess?.pid && chromeProcess.exitCode === null) {
    chromeProcess.kill('SIGTERM')
    await Promise.race([onceClosed(chromeProcess), delay(3_000)])
    if (chromeProcess.exitCode === null) chromeProcess.kill('SIGKILL')
  }
  server.closeAllConnections?.()
  await close(server)
  if (/download-sample(?: \(\d+\))?\.txt$/.test(downloadedFile)) await rm(downloadedFile, { force: true })
  await rm(profileDir, { recursive: true, force: true })
}

// Nothing here holds the loop open on purpose, and the sockets do not always close promptly:
// exiting explicitly is what keeps a finished smoke from leaving Chrome behind.
process.exit(failed ? 1 : 0)

function listen(httpServer) {
  return new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', rejectPromise)
      resolvePromise()
    })
  })
}

function close(httpServer) {
  if (!httpServer.listening) return Promise.resolve()
  return new Promise(resolvePromise => httpServer.close(() => resolvePromise()))
}

function onceClosed(child) {
  if (child.exitCode !== null) return Promise.resolve()
  return new Promise(resolvePromise => child.once('close', resolvePromise))
}

async function waitFor(predicate, timeoutMs, message) {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(message)
    if (chromeProcess?.exitCode !== null) throw new Error(`Chrome exited before the extension connected (code ${chromeProcess.exitCode}).`)
    await delay(100)
  }
}

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function printChromeDiagnostics(userDataDir) {
  try {
    const [port] = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    console.error('Chrome DevTools targets:', targets.map(target => JSON.stringify({ type: target.type, title: target.title, url: target.url })).join(', ') || '(none)')
    for (const target of targets.filter(target => target.type === 'service_worker')) {
      const manifest = await evaluate(target.webSocketDebuggerUrl, 'chrome.runtime.getManifest()').catch(() => undefined)
      if (manifest) console.error('Chrome service worker manifest:', JSON.stringify(manifest))
      if (manifest?.name === 'Shun Browser Use') {
        const bridge = await evaluate(target.webSocketDebuggerUrl, `({
          ports: typeof PORTS === 'undefined' ? [] : PORTS,
          socketState: typeof socket === 'undefined' || !socket ? -1 : socket.readyState,
          connectedPort: typeof connectedPort === 'undefined' ? null : connectedPort
        })`).catch(error => ({ diagnosticError: String(error) }))
        console.error('Shun Browser Use bridge state:', JSON.stringify(bridge))
        const websocketProbe = await evaluate(target.webSocketDebuggerUrl, `new Promise(resolve => {
          const candidate = new WebSocket('ws://127.0.0.1:${service.port || 32124}')
          const timer = setTimeout(() => resolve({ outcome: 'timeout', state: candidate.readyState }), 1500)
          candidate.onopen = () => { clearTimeout(timer); candidate.close(); resolve({ outcome: 'open' }) }
          candidate.onerror = () => { clearTimeout(timer); resolve({ outcome: 'error', state: candidate.readyState }) }
          candidate.onclose = event => { clearTimeout(timer); resolve({ outcome: 'close', code: event.code, reason: event.reason, clean: event.wasClean }) }
        })`).catch(error => ({ diagnosticError: String(error) }))
        console.error('Shun Browser Use WebSocket probe:', JSON.stringify(websocketProbe))
      }
    }
  } catch {}
  try {
    const preferences = JSON.parse(await readFile(join(userDataDir, 'Default', 'Preferences'), 'utf8'))
    console.error('Chrome extension settings:', Object.keys(preferences.extensions?.settings || {}).join(', ') || '(none)')
  } catch {}
}

function evaluate(webSocketUrl, expression) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(webSocketUrl)
    const timer = setTimeout(() => { socket.close(); rejectPromise(new Error('CDP evaluation timed out.')) }, 2_000)
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })))
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message.id !== 1) return
      clearTimeout(timer)
      socket.close()
      resolvePromise(message.result?.result?.value)
    })
    socket.once('error', error => { clearTimeout(timer); rejectPromise(error) })
  })
}
