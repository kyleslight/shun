/**
 * Fast Browser Use live test: the fast path driving real Chrome.
 *
 * The fixture benchmark proves the decision loop against recorded accessibility
 * state. This proves the part that actually matters — that a delegated subgoal
 * becomes real clicks, real typing, and real keystrokes in a real Chrome, one
 * fresh accessibility snapshot per action, ending on its own when the subgoal is
 * done. Only the pages are local, so the run is deterministic; nothing about the
 * browser is simulated.
 *
 * It drives Chrome over the DevTools protocol on a throwaway profile, which keeps
 * the test independent of the bundled extension and of the store build. The
 * extension bridge itself is covered by the Browser Use smoke test, so a failure
 * here is a failure of the fast path, not of the transport.
 *
 *   OPENROUTER_API_KEY=... npm run smoke:browser-fast-live
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import WebSocket from 'ws'
import { BrowserFastExecutor } from '../src/main/browser-fast.ts'
import { OpenRouterJevClient, resolveComputerUseAcceleration } from '../src/main/jev-client.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const chromeCandidates = process.env.SHUN_CHROME_BINARY
  ? [process.env.SHUN_CHROME_BINARY]
  : process.platform === 'darwin'
    ? ['/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/opt/chrome-for-testing/chrome', '/usr/local/bin/google-chrome', '/usr/bin/google-chrome']
const chrome = chromeCandidates.find(candidate => candidate && existsSync(candidate))
if (!chrome) throw Error(`Chrome was not found (looked for ${chromeCandidates.join(', ')}). Set SHUN_CHROME_BINARY.`)
const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim()
if (!apiKey) throw Error('The Fast Browser Use live test needs a decision-model credential: set OPENROUTER_API_KEY.')

const REPOSITORIES = ['notes', 'godot-presets', 'browser-extension', 'terminal-runtime', 'plugin-registry', 'sites', 'release-tools', 'benchmarks', 'design-system', 'schedules', 'cloudflare-workers', 'shun']

const PAGES = {
  '/': `<!doctype html><html><head><title>kyleslight/shun</title></head><body>
    <h1>kyleslight/shun</h1>
    <nav><a href="/issues">Issues</a> <a href="/settings">Settings</a> <a href="/repositories">All repositories</a></nav>
    <p>Code. Pull requests. Actions.</p>
  </body></html>`,
  '/issues': `<!doctype html><html><head><title>Issues · kyleslight/shun</title></head><body><h1>Issues</h1></body></html>`,
  '/settings': `<!doctype html><html><head><title>Settings · kyleslight/shun</title></head><body>
    <h1>Repository settings</h1>
    <nav><a href="/settings/general">General</a> <a href="/settings/actions">Actions</a> <a href="/settings/pages">Pages</a></nav>
  </body></html>`,
  '/settings/general': `<!doctype html><html><head><title>General · Settings</title></head><body><h1>General settings</h1><p>Repository name: shun</p></body></html>`,
  '/settings/pages': `<!doctype html><html><head><title>Pages · Settings</title></head><body><h1>Pages</h1></body></html>`,
  '/settings/actions': `<!doctype html><html><head><title>Actions · Settings</title></head><body>
    <h1>Actions settings</h1>
    <div role="tablist">
      <button role="tab" aria-selected="false">Runners</button>
      <button role="tab" aria-selected="false">General</button>
    </div>
    <p id="panel">Choose a tab</p>
    <script>
      for (const tab of document.querySelectorAll('[role=tab]')) tab.addEventListener('click', () => {
        for (const other of document.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', String(other === tab))
        document.querySelector('#panel').textContent = tab.textContent + ' actions settings'
      })
    </script>
  </body></html>`,
  '/repositories': `<!doctype html><html><head><title>All repositories</title></head><body>
    <h1>All repositories</h1>
    <label>Find a repository <input type="search" aria-label="Find a repository"></label>
    <button id="search">Search</button>
    <p id="status">${REPOSITORIES.length} repositories</p>
    <ul id="list">${REPOSITORIES.map(name => `<li><a href="${name === 'shun' ? '/' : '/settings/pages'}">${name}</a></li>`).join('')}</ul>
    <script>
      const filter = () => {
        const query = document.querySelector('input[aria-label="Find a repository"]').value.trim().toLowerCase()
        let shown = 0
        for (const item of document.querySelectorAll('#list li')) {
          const visible = !query || item.textContent.toLowerCase().includes(query)
          item.style.display = visible ? '' : 'none'
          if (visible) shown += 1
        }
        document.querySelector('#status').textContent = shown + ' repositories match ' + query
      }
      document.querySelector('input[aria-label="Find a repository"]').addEventListener('input', filter)
      document.querySelector('#search').addEventListener('click', filter)
    </script>
  </body></html>`,
}

/** Each delegated subgoal names the page it starts from and what proves it worked. */
const SUBGOALS = [
  {
    id: 'open-settings',
    start: '/',
    goal: 'Open the Settings page of this repository.',
    verify: (result, page) => result.status === 'completed' && page.url.endsWith('/settings'),
  },
  {
    id: 'actions-general',
    start: '/settings',
    goal: 'Open the Actions settings page, then its General tab.',
    verify: (result, page) => result.status === 'completed' && page.url.endsWith('/settings/actions') && page.text.includes('General actions settings'),
  },
  {
    id: 'search-repository',
    start: '/repositories',
    goal: 'Filter the repository list by typing the supplied query into the Find a repository field, then open the shun repository.',
    input: { query: 'shun' },
    verify: (result, page) => result.status === 'completed'
      && result.steps.some(step => step.action.startsWith('type:'))
      && page.url.endsWith('/'),
  },
]

const profileDir = await mkdtemp(join(tmpdir(), 'shun-browser-fast-live-'))
const server = createServer((request, response) => {
  const path = String(request.url || '/').split('?')[0]
  const body = PAGES[path]
  response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body || '<!doctype html><title>Not found</title><h1>Not found</h1>')
})

let chromeProcess
let stderr = ''
let session

async function main() {
try {
  await listen(server)
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('The live fixture server did not expose a TCP port.')
  const origin = `http://127.0.0.1:${address.port}`

  chromeProcess = spawn(chrome, [
    `--user-data-dir=${profileDir}`,
    ...(process.env.SHUN_CHROME_HEADFUL === '1' ? [] : ['--headless=new']),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-proxy-server',
    '--remote-debugging-port=0',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  chromeProcess.stderr.setEncoding('utf8')
  chromeProcess.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-8_000) })

  const port = await devToolsPort(profileDir)
  session = await RealChromeSession.connect(port)
  console.log(`${session.version} driven over the DevTools protocol on a throwaway profile\n`)

  const resolved = resolveComputerUseAcceleration({
    providers: [{ id: 'openrouter', name: 'OpenRouter', kind: 'cloud', catalogId: 'openrouter', api: 'openai-completions', endpoint: 'https://openrouter.ai/api/v1', apiKey, contextWindow: 32_768 }],
  })
  const client = new OpenRouterJevClient({ apiKey, endpoint: resolved.endpoint, timeoutMs: 20_000 })

  let failures = 0
  for (const subgoal of SUBGOALS) {
    await session.goto(`${origin}${subgoal.start}`)
    const started = Date.now()
    const executor = new BrowserFastExecutor(session, client, resolved, { runId: `live:${subgoal.id}` })
    const result = await executor.execute({ taskId: 'browser-fast-live', browserSessionId: 'live-session', goal: subgoal.goal, input: subgoal.input })
    const page = await session.describe()
    const ok = subgoal.verify(result, page)
    if (!ok) failures += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} ${subgoal.id.padEnd(20)} status=${result.status} steps=${result.steps.length} wall=${Date.now() - started}ms decision≈${result.metrics.averageDecisionMs}ms`)
    console.log(`     actions: ${result.steps.map(step => `${step.action}@${step.probability?.toFixed(2) ?? '-'}`).join(' → ') || '(none)'}`)
    console.log(`     page:    ${page.url}`)
    if (!ok && result.reason) console.log(`     reason:  ${result.reason}`)
  }

  console.log(`\n${failures ? `${failures} of ${SUBGOALS.length} subgoals failed` : `all ${SUBGOALS.length} subgoals driven end to end by the fast path in real Chrome`}`)
  if (failures) process.exitCode = 1
} catch (error) {
  if (stderr) console.error(stderr)
  throw error
} finally {
  session?.close()
  await close(server)
  if (chromeProcess?.pid && chromeProcess.exitCode === null) {
    chromeProcess.kill('SIGTERM')
    await Promise.race([once(chromeProcess).catch(() => {}), delay(3_000)])
    if (chromeProcess.exitCode === null) chromeProcess.kill('SIGKILL')
  }
  await rm(profileDir, { recursive: true, force: true })
  }
}

/**
 * A BrowserFastHost over the DevTools protocol.
 *
 * Refs are assigned per snapshot and map to DOM backend node ids, so the same
 * "fresh refs, never reuse a stale one" contract the product gives the model holds
 * here too. Actions are dispatched as real input events rather than by scripting
 * the page, because a synthetic .click() would not prove that a real user input
 * reaches the page.
 */
class RealChromeSession {
  #socket
  #nextId = 1
  #pending = new Map()
  #refs = new Map()
  version = 'Chrome'

  static async connect(port) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    const page = targets.find(target => target.type === 'page')
    if (!page?.webSocketDebuggerUrl) throw Error('Chrome exposed no page target to drive.')
    const session = new RealChromeSession()
    await session.#open(page.webSocketDebuggerUrl)
    await session.send('Page.enable')
    await session.send('DOM.enable')
    await session.send('Accessibility.enable')
    await session.send('Runtime.enable')
    const version = await session.send('Browser.getVersion').catch(() => undefined)
    session.version = version ? `${version.product} (${version.protocolVersion})` : 'Chrome'
    return session
  }

  #open(url) {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(url)
      this.#socket = socket
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString())
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        message.error ? pending.reject(Error(message.error.message)) : pending.resolve(message.result)
      })
      socket.once('open', () => resolvePromise())
      socket.once('error', rejectPromise)
    })
  }

  send(method, params = {}) {
    const id = this.#nextId++
    this.#socket.send(JSON.stringify({ id, method, params }))
    return new Promise((resolvePromise, rejectPromise) => this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise }))
  }

  close() {
    try { this.#socket?.close() } catch {}
  }

  async #evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true })
    return result?.result?.value
  }

  async #settle() {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      if (await this.#evaluate('document.readyState') === 'complete') break
      await delay(100)
    }
    // One page scripts its own DOM after load; a short settle lets that land
    // before the next snapshot, which is what the product does too.
    await delay(200)
  }

  async goto(url) {
    await this.send('Page.navigate', { url })
    await this.#settle()
  }

  async describe() {
    const [url, title, text] = await Promise.all([
      this.#evaluate('location.href'),
      this.#evaluate('document.title'),
      this.#evaluate('document.body ? document.body.innerText.slice(0, 8000) : ""'),
    ])
    return { url: String(url || ''), title: String(title || ''), text: String(text || '') }
  }

  /** The host interface the executor consumes. */
  async snapshot() {
    const page = await this.describe()
    const readyState = await this.#evaluate('document.readyState')
    const tree = await this.send('Accessibility.getFullAXTree')
    this.#refs = new Map()
    const nodes = []
    for (const node of tree.nodes || []) {
      const role = node.role?.value
      if (!role || role === 'none' || role === 'generic' || role === 'InlineTextBox' || role === 'StaticText' || !node.backendDOMNodeId) continue
      const ref = String(nodes.length + 1)
      this.#refs.set(ref, node.backendDOMNodeId)
      const properties = Object.fromEntries((node.properties || []).map(property => [property.name, property.value?.value]))
      nodes.push({
        ref,
        role: String(role).toLowerCase(),
        name: node.name?.value ? String(node.name.value) : undefined,
        value: node.value?.value === undefined ? undefined : String(node.value.value),
        ...(properties.focused ? { focused: true } : {}),
        ...(properties.disabled || properties.readonly ? { disabled: true } : {}),
        ...(properties.checked !== undefined ? { checked: properties.checked === 'true' || properties.checked === true } : {}),
        ...(properties.expanded !== undefined ? { expanded: properties.expanded === 'true' || properties.expanded === true } : {}),
        ...(properties.selected !== undefined ? { selected: properties.selected === 'true' || properties.selected === true } : {}),
      })
      if (nodes.length >= 300) break
    }
    const snapshot = { tab: { id: 1, url: page.url, title: page.title }, readyState, text: page.text, nodes }
    return {
      session: this.#session(page.url, page.title),
      snapshot,
      text: JSON.stringify({ title: page.title, url: page.url, ready_state: readyState, accessibility_nodes: nodes.length, visible_text: page.text }, null, 2),
    }
  }

  async act(_taskId, _sessionId, action) {
    const backendNodeId = action.ref ? this.#refs.get(String(action.ref)) : undefined
    if (action.ref && !backendNodeId) throw Error(`Chrome no longer has accessibility ref ${action.ref}; take a fresh snapshot.`)
    if (action.action === 'click' || action.action === 'select') {
      const box = await this.send('DOM.getBoxModel', { backendNodeId }).catch(() => undefined)
      const quad = box?.model?.content
      if (!quad) {
        const { object } = await this.send('DOM.resolveNode', { backendNodeId })
        await this.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.click(); }' })
      } else {
        const [x, y] = [(quad[0] + quad[2] + quad[4] + quad[6]) / 4, (quad[1] + quad[3] + quad[5] + quad[7]) / 4]
        for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
          await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
        }
      }
    } else if (action.action === 'type') {
      const { object } = await this.send('DOM.resolveNode', { backendNodeId })
      if (action.clear !== false) await this.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.focus(); this.select && this.select(); }' })
      else await this.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { this.focus(); }' })
      await this.send('Input.insertText', { text: String(action.text ?? '') })
    } else if (action.action === 'keypress') {
      const key = String(action.key || 'Enter')
      const codes = { Enter: { code: 'Enter', keyCode: 13, text: '\r' }, Escape: { code: 'Escape', keyCode: 27 }, Tab: { code: 'Tab', keyCode: 9 }, Backspace: { code: 'Backspace', keyCode: 8 }, Space: { code: 'Space', keyCode: 32, text: ' ' } }
      const spec = codes[key] || { code: key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, text: key.length === 1 ? key : undefined }
      const base = { key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode }
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base })
      if (spec.text) await this.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: spec.text })
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    } else if (action.action === 'scroll') {
      const viewport = await this.#evaluate('JSON.stringify([innerWidth / 2, innerHeight / 2])')
      const [x, y] = JSON.parse(viewport || '[400,300]')
      const distance = 600 * Math.max(1, Number(action.amount) || 1) * (action.direction === 'up' ? -1 : action.direction === 'down' ? 1 : 0)
      await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: action.direction === 'left' ? -distance : action.direction === 'right' ? distance : 0, deltaY: distance })
    } else if (action.action === 'back' || action.action === 'forward') {
      await this.#evaluate(`history.${action.action}()`)
    } else if (action.action === 'reload') {
      await this.send('Page.reload')
    } else {
      throw Error(`The live harness does not implement the ${action.action} action.`)
    }
    await this.#settle()
    return this.snapshot()
  }

  #session(url, title) {
    return {
      id: 'live-session', taskId: 'browser-fast-live', createdByRunId: 'browser-fast-live', tabId: 1, owned: true, state: 'attached',
      url, title, createdAt: Date.now(), updatedAt: Date.now(), consoleEntries: 0, pageErrors: 0,
    }
  }
}

async function devToolsPort(userDataDir) {
  const file = join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const [port] = (await readFile(file, 'utf8')).trim().split('\n')
      if (port) return Number(port)
    } catch {}
    await delay(100)
  }
  throw Error('Chrome did not publish a DevTools port.')
}

function listen(httpServer) {
  return new Promise((resolvePromise, rejectPromise) => {
    httpServer.once('error', rejectPromise)
    httpServer.listen(0, '127.0.0.1', () => { httpServer.off('error', rejectPromise); resolvePromise() })
  })
}

function close(httpServer) {
  if (!httpServer.listening) return Promise.resolve()
  return new Promise(resolvePromise => httpServer.close(() => resolvePromise()))
}

function delay(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

// The session class must be initialised before the run starts, so the entry point
// sits at the end of the file rather than before it.
await main()
