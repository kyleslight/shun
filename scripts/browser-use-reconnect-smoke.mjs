import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'

// An isolated real browser and bridge: never touches the person's Chrome profile.
const chrome = process.env.SHUN_CHROME_BINARY
if (!chrome) throw Error('Set SHUN_CHROME_BINARY to Chrome for Testing.')
const profile = await mkdtemp(join(tmpdir(), 'shun-browser-reconnect-'))
const peers = new Set()
const transports = new Set()
let browser, server, protocol, port, answers = 0, connected = 0
let handshakeDelay = 1_200
let answering = true
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, timeout, label) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      const [debugPort] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json())
      console.error(targets.map(t => ({ type: t.type, url: t.url })))
      const worker = targets.find(t => t.url.endsWith('/service-worker.js'))
      if (worker) console.error(await evaluate(worker.webSocketDebuggerUrl, 'JSON.stringify({ports:PORTS, connectionAttempt, connectedPort, lastPort, state:socket?.readyState})'))
      throw Error(`Timed out: ${label}`)
    }
    await pause(50)
  }
  console.log(`${label}: ${Date.now() - start}ms`)
}
async function listen() {
  protocol = new WebSocketServer({ noServer: true })
  protocol.on('connection', socket => {
    peers.add(socket)
    socket.on('close', () => peers.delete(socket))
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message.type === 'hello') connected++
      if (!answering) return
      if (message.type === 'hello' || message.type === 'heartbeat') {
        answers++
        socket.send(JSON.stringify({ type: `${message.type}.ack`, heartbeat: true }))
      }
    })
  })
  server = createServer()
  server.on('connection', socket => { if (process.env.SHUN_RECONNECT_DEBUG) console.log('TCP received'); transports.add(socket); socket.on('close', () => transports.delete(socket)) })
  server.on('upgrade', (request, socket, head) => {
    if (process.env.SHUN_RECONNECT_DEBUG) console.log('upgrade received')
    const timer = setTimeout(() => {
      if (!socket.destroyed) protocol.handleUpgrade(request, socket, head, ws => protocol.emit('connection', ws))
    }, handshakeDelay)
    socket.on('close', () => clearTimeout(timer))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port || 0, '127.0.0.1', resolve) })
  port = server.address().port
}
async function stopBridge() {
  for (const peer of peers) peer.terminate()
  for (const socket of transports) socket.destroy()
  await new Promise(resolve => protocol.close(resolve))
  await new Promise(resolve => server.close(resolve))
}
async function launch() {
  browser = spawn(chrome, [
    `--user-data-dir=${profile}`, `--load-extension=${join(profile, 'extension')}`,
    `--disable-extensions-except=${join(profile, 'extension')}`,
    '--remote-debugging-port=0', ...(process.env.SHUN_CHROME_HEADFUL === '1' ? [] : ['--headless=new']), '--no-first-run', '--no-default-browser-check',
    '--use-mock-keychain', '--password-store=basic', '--disable-gpu', '--no-proxy-server',
    '--disable-features=DisableLoadExtensionCommandLineSwitch,LocalNetworkAccessChecks',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  browser.stderr.on('data', chunk => { if (process.env.SHUN_RECONNECT_DEBUG) process.stderr.write(chunk) })
  browser.on('error', error => console.error(error.message))
  browser.on('exit', (code, signal) => { if (code) console.error('Isolated Chrome exit:', code, signal) })

}
async function stopBrowser() {
  if (!browser || browser.exitCode !== null) return
  const closed = new Promise(resolve => browser.once('exit', resolve))
  browser.kill('SIGTERM')
  await Promise.race([closed, pause(3_000)])
  if (browser.exitCode === null) { browser.kill('SIGKILL'); await closed }
}
try {
  await listen()

  await cp(resolve('resources/browser-use-extension'), join(profile, 'extension'), { recursive: true })
  const path = join(profile, 'extension/service-worker.js')
  let source = await readFile(path, 'utf8')
  if (process.env.SHUN_RECONNECT_TEST_OLD === '1') source = source.replace('const CONNECT_TIMEOUT_MS = 10_000', 'const CONNECT_TIMEOUT_MS = 550')
  await writeFile(path, source.replace('const PORTS = Array.from({ length: 10 }, (_, index) => 32124 + index)', `const PORTS = [${port}]`))
  await launch()
  await until(() => answers > 0, 15_000, 'delayed handshake automatically connects')
  await stopBridge()
  await pause(1_000)
  const before = connected
  await listen()
  await until(() => connected > before, 8_000, 'bridge restart automatically reconnects')
  const silent = connected
  answering = false
  await until(() => connected > silent, 8_000, 'silent connection is replaced')
  answering = true
  const recovered = answers
  await until(() => answers > recovered, 6_000, 'heartbeat answers recover')
  await stopBrowser()
  const restarted = connected
  await launch()
  await until(() => connected > restarted, 15_000, 'browser restart automatically reconnects')
  const healthy = connected
  await pause(32_000)
  assert.equal(connected, healthy, 'the reconnect alarm must not replace a healthy connection')
  console.log('REAL_BROWSER_RECONNECT_PASSED')
} finally {
  await stopBrowser()
  await stopBridge()
  await rm(profile, { recursive: true, force: true })
}

function evaluate(url, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => { ws.close(); reject(Error('Diagnostic timeout')) }, 3_000)
    ws.on('open', () => { ws.send(JSON.stringify({ id: 2, method: 'Log.enable' })); ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })) })
    ws.on('message', raw => { const message = JSON.parse(raw); if (message.method === 'Log.entryAdded') console.error(message.params.entry.text); if (message.id !== 1) return; clearTimeout(timer); setTimeout(() => { ws.close(); resolve(message.result) }, 500) })
    ws.on('error', reject)
  })
}
