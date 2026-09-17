// A research renderer for measurements that run under plain node.
//
// The product renders through the hidden Chromium it owns, and under Electron the harness
// uses that same renderer. Without Electron the measurement could only use the curl path,
// which left the whole rendering channel — JavaScript pages, consent walls, engines that
// refuse a plain fetch — unmeasured.
//
// One headless browser is kept alive and driven over the DevTools protocol, because that is
// what the product does (one hidden window, many pages) and because spawning a browser per
// page costs more than the page. It runs on a throwaway profile, so it is never anyone's
// logged-in session, and it is only ever pointed at the same public URLs the product reads.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const defaultChromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitForEndpoint(profile, deadline) {
  let lastError
  while (Date.now() < deadline) {
    try {
      // The first line is the port and the second is this browser's own WebSocket path;
      // connecting to the bare /devtools/browser path is refused.
      const [port, path] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n').map(line => line.trim()).filter(Boolean)
      if (port && path) return { port: Number(port), path }
    } catch (error) { lastError = error }
    await sleep(120)
  }
  throw lastError || Error('headless chrome never reported a debugging endpoint')
}

/** Minimal DevTools client: one socket, request ids, and an event buffer. */
function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  const listeners = new Set()
  let nextId = 0
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      message.error ? entry.reject(Error(message.error.message)) : entry.resolve(message.result)
      return
    }
    for (const listener of listeners) listener(message)
  })
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', event => reject(Error(`devtools socket failed: ${event?.message || event?.error?.message || 'unknown'}`)))
  })
  return {
    opened,
    on(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    send(method, params = {}, sessionId) {
      const id = ++nextId
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        setTimeout(() => {
          if (pending.delete(id)) reject(Error(`devtools ${method} timed out`))
        }, 20_000)
      })
    },
    close() { try { socket.close() } catch {} },
  }
}

export function createHeadlessChromeRenderer(options = {}) {
  const binary = options.binary || process.env.SHUN_BENCH_CHROME || defaultChromePath
  const navigateTimeoutMs = options.navigateTimeoutMs || 12_000
  const profile = mkdtempSync(join(tmpdir(), 'shun-bench-chrome-'))
  let child
  let client

  const start = async () => {
    child = spawn(binary, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--mute-audio',
      '--hide-scrollbars',
      '--remote-debugging-port=0',
      // Chrome refuses DevTools WebSocket connections that do not come from its own UI
      // unless the origins are allowed explicitly.
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { stdio: 'ignore' })
    const endpoint = await waitForEndpoint(profile, Date.now() + 20_000)
    client = connect(`ws://127.0.0.1:${endpoint.port}${endpoint.path}`)
    await client.opened
  }

  const ready = start()

  return {
    profile,
    async close() {
      try { await ready } catch {}
      client?.close()
      child?.kill('SIGKILL')
      try { rmSync(profile, { recursive: true, force: true }) } catch {}
    },
    /**
     * Renders one public URL and returns the DOM as the browser has it now, which is what
     * a reader needs from a page that builds itself in JavaScript.
     */
    async renderPage(url) {
      await ready
      const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
      try {
        await client.send('Page.enable', {}, sessionId)
        await client.send('Runtime.enable', {}, sessionId)
        const loaded = new Promise(resolve => {
          const off = client.on(message => {
            if (message.sessionId === sessionId && message.method === 'Page.loadEventFired') { off(); resolve() }
          })
          setTimeout(() => { off(); resolve() }, navigateTimeoutMs)
        })
        await client.send('Page.navigate', { url }, sessionId)
        await loaded
        // A page that fills itself in after load would otherwise be measured as its shell.
        await sleep(600)
        const evaluated = await client.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId)
        const html = String(evaluated?.result?.value || '')
        if (!html.trim()) throw Error('headless chrome returned an empty DOM')
        return { html, finalUrl: url }
      } finally {
        client.send('Target.closeTarget', { targetId }).catch(() => {})
      }
    },
  }
}
