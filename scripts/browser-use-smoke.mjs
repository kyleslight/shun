import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
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
    <a href="/download">Download sample</a>
  </body></html>`)
})

let chromeProcess
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

  const downloaded = await service.download('browser-smoke-task', session.id, download.ref, 20_000)
  downloadedFile = String(downloaded?.filename || '')
  if (downloaded?.state !== 'complete' || !/download-sample(?: \(\d+\))?\.txt$/.test(downloadedFile)) throw new Error('Chrome download did not complete with the expected file.')
  console.log('download: completion and final local filename observed')

  await service.releaseRun('browser-smoke-task', 'browser-smoke-run')
  if ((await service.list('browser-smoke-task')).length) throw new Error('Browser session remained active after its model run was released.')
  console.log('run release: debugger detached and tab kept open')

} catch (error) {
  await printChromeDiagnostics(profileDir)
  if (stderr) console.error(stderr)
  throw error
} finally {
  await service.stop().catch(() => {})
  await close(server)
  if (chromeProcess?.pid && chromeProcess.exitCode === null) {
    chromeProcess.kill('SIGTERM')
    await Promise.race([onceClosed(chromeProcess), delay(3_000)])
    if (chromeProcess.exitCode === null) chromeProcess.kill('SIGKILL')
  }
  if (/download-sample(?: \(\d+\))?\.txt$/.test(downloadedFile)) await rm(downloadedFile, { force: true })
  await rm(profileDir, { recursive: true, force: true })
}

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
