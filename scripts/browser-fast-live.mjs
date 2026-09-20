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
 *   OPENROUTER_API_KEY=... npm run smoke:browser-fast-live
 *
 * It also runs any real page as a one-off control experiment, which is how a
 * claim about a specific site gets measured instead of argued:
 *
 *   ... --url https://example.com/game --goal "Press ArrowUp to steer." \\
 *       --control --keys ArrowUp,ArrowDown --max-steps 30 --repeat 3
 *
 * It drives Chrome over the DevTools protocol on a throwaway profile, which keeps
 * the test independent of the bundled extension and of the store build. The
 * extension bridge itself is covered by the Browser Use smoke test, so a failure
 * here is a failure of the fast path, not of the transport.
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
import { BrowserFastExecutor, buildActionCandidates, runGoalBatch } from '../src/main/browser-fast.ts'
import { BrowserControlBlockedError } from '../src/main/chrome-browser.ts'
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
  /** A control that something is in front of: the exact shape a click must refuse. */
  '/covered': `<!doctype html><html><head><title>Covered control</title></head><body>
    <h1>Covered control</h1>
    <p id="status">Unsaved</p>
    <button id="save">Save</button>
    <div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.35)">
      <button id="dismiss">Dismiss</button>
    </div>
    <script>
      document.querySelector('#dismiss').addEventListener('click', () => document.querySelector('#veil').remove())
      document.querySelector('#save').addEventListener('click', () => { document.querySelector('#status').textContent = 'Saved' })
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
  /**
   * A canvas that counts keystrokes into a variable the page never displays. The
   * accessibility tree, the title, and the visible text are identical before and
   * after every press, which is exactly the shape that made a sustained control
   * task look like a stuck loop.
   */
  '/play': `<!doctype html><html><head><title>Steering</title></head><body>
    <h1>Steering</h1>
    <canvas id="field" width="320" height="320" tabindex="0" aria-label="Field"></canvas>
    <script>
      window.__keys = 0
      const field = document.querySelector('#field')
      field.focus()
      addEventListener('keydown', event => {
        if (event.key !== 'ArrowUp') return
        window.__keys += 1
        const context = field.getContext('2d')
        context.fillStyle = 'hsl(200 70% ' + (20 + (window.__keys % 40)) + '%)'
        context.fillRect(0, 0, 320, 320)
      })
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
  {
    // A click must never land on whatever happens to be in front. Here a dialog
    // covers the button, so the honest outcome is a refusal that names it.
    id: 'covered-control',
    start: '/covered',
    goal: 'Save the form.',
    plan: ['Save'],
    cycles: 1,
    verify: result => result.status === 'escalate' && /behind/i.test(String(result.reason || '')),
  },
  {
    // Once the dialog is out of the way the same control works, so the refusal was
    // about the page state and not about the control.
    id: 'covered-after-dismiss',
    start: '/covered',
    goal: 'Dismiss the dialog, then save the form.',
    plan: ['Dismiss', 'Save'],
    cycles: 1,
    verify: (result, page) => page.text.includes('Saved'),
  },
  {
    // A caller-determined plan on an ordinary navigation flow: the steps are named,
    // so nothing has to be computed or chosen, and the harness runs them at browser
    // speed. Nothing about this is game-shaped.
    id: 'settings-by-plan',
    start: '/settings',
    goal: 'Open the Actions settings page, then its General tab.',
    plan: ['Actions', 'General'],
    cycles: 1,
    verify: (result, page) => result.metrics.browserActions === 2 && result.metrics.jevCalls === 1
      && page.url.endsWith('/settings/actions') && page.text.includes('General actions settings'),
  },
  {
    // The same mechanism over a paginated list: one named control, run until the goal
    // is reached, at browser speed instead of at decision speed.
    id: 'paged-by-plan',
    start: '/paged?n=1',
    goal: 'Read every page of this list.',
    plan: ['Next page'],
    cycles: 4,
    verify: result => result.metrics.browserActions >= 3 && result.metrics.jevCalls <= 4
      && result.steps.every(step => step.action.startsWith('click:')),
  },
  {
    // The regression this guards: a frame that never changes used to end the fast
    // loop after two actions, so a control task could not be sustained at all.
    id: 'sustained-keyboard',
    start: '/play',
    goal: 'Press ArrowUp over and over to steer.',
    keys: ['ArrowUp'],
    control: true,
    maxSteps: 10,
    verify: async (result, _page, session) => result.metrics.browserActions >= 8
      && await session.evaluateNumber('window.__keys || 0') >= 8,
  },
]

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/**
 * Any real page can be measured as a one-off control experiment, so a claim about
 * a specific site becomes a number instead of an argument. Without --url the
 * built-in fixture set runs.
 */
const adHoc = option('url')
  ? [{
      id: option('name', 'ad-hoc'),
      start: '',
      absolute: String(option('url')),
      goal: String(option('goal', 'Inspect this page and take one obvious action.')),
      control: process.argv.includes('--control'),
      keys: option('keys') ? String(option('keys')).split(',').map(key => key.trim()).filter(Boolean) : undefined,
      maxSteps: Number(option('max-steps', 0)) || undefined,
      maxUncertainSteps: Number(option('max-uncertain-steps', 0)) || undefined,
      maxRepeat: Number(option('max-repeat', 0)) || undefined,
      plan: option('plan') ? String(option('plan')).split('|').map(step => step.trim()).filter(Boolean) : undefined,
      cycles: Number(option('cycles', 0)) || undefined,
      expect: option('expect'),
      verify: async (result, page) => (option('expect') ? page.text.includes(String(option('expect'))) : true),
    }]
  : []
const repeats = Math.max(1, Number(option('repeat', 1)) || 1)
/** Independent goals separated by || — one tab each, advanced at the same time. */
const parallelGoals = option('parallel-goals')
  ? String(option('parallel-goals')).split('||').map(goal => goal.trim()).filter(Boolean)
  : []

/** An ordinary paginated list: the same one control, clicked until the end. */
const pagedPage = n => `<!doctype html><html><head><title>Records ${n} of 4</title></head><body>
  <h1>Records — page ${n} of 4</h1>
  <p>Records ${n * 10 - 9} to ${n * 10}</p>
  ${n < 4 ? `<a href="/paged?n=${n + 1}">Next page</a>` : '<p>Last page.</p>'}
</body></html>`

const profileDir = await mkdtemp(join(tmpdir(), 'shun-browser-fast-live-'))
const server = createServer((request, response) => {
  const target = new URL(String(request.url || '/'), 'http://127.0.0.1')
  const path = target.pathname
  const body = path === '/paged' ? pagedPage(Number(target.searchParams.get('n')) || 1) : PAGES[path]
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
  if (option('eval')) {
    await session.goto(String(option('url')))
    await delay(1200)
    console.log('eval:', await session.evaluate(String(option('eval'))))
  }

  const resolved = resolveComputerUseAcceleration({
    providers: [{ id: 'openrouter', name: 'OpenRouter', kind: 'cloud', catalogId: 'openrouter', api: 'openai-completions', endpoint: 'https://openrouter.ai/api/v1', apiKey, contextWindow: 32_768 }],
  })
  const client = new OpenRouterJevClient({ apiKey, endpoint: resolved.endpoint, timeoutMs: 20_000 })

  if (parallelGoals.length > 1) {
    const extraSessions = []
    for (let index = 1; index < parallelGoals.length; index++) {
      const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(String(option('url')))}`, { method: 'PUT' }).then(response => response.json())
      const session = await RealChromeSession.connect(port, created.id)
      extraSessions.push(session)
    }
    const sessions = [session, ...extraSessions]
    for (const candidate of sessions) await candidate.goto(String(option('url')))
    await delay(1200)
    const started = Date.now()
    const results = await runGoalBatch(parallelGoals, sessions.length, goal => {
      const index = parallelGoals.indexOf(goal)
      return new BrowserFastExecutor(sessions[index], client, resolved, { runId: `parallel:${index}` }).execute({
        taskId: 'browser-fast-live', browserSessionId: `live-${index}`, goal, keys: adHoc[0]?.keys, control: adHoc[0]?.control, maxSteps: adHoc[0]?.maxSteps,
      })
    })
    const wall = Date.now() - started
    const total = results.reduce((sum, result) => sum + result.elapsed_ms, 0)
    console.log(`parallel: ${results.length} goals, wall ${wall}ms vs ${total}ms if serialized  (${(total / Math.max(1, wall)).toFixed(2)}x)`)
    for (const [index, result] of results.entries()) console.log(`  goal ${index + 1}: ${result.status} actions=${result.metrics.browserActions} decisions=${result.metrics.jevCalls} ${result.elapsed_ms}ms  ${parallelGoals[index].slice(0, 60)}`)
    for (const candidate of extraSessions) candidate.close()
    session.close()
    await close(server)
    if (chromeProcess?.pid && chromeProcess.exitCode === null) { chromeProcess.kill('SIGTERM'); await Promise.race([once(chromeProcess).catch(() => {}), delay(3_000)]) }
    await rm(profileDir, { recursive: true, force: true })
    process.exit(0)
  }

  let failures = 0
  const planned = adHoc.length ? adHoc : SUBGOALS
  for (const subgoal of planned) {
    for (let attempt = 1; attempt <= (adHoc.length ? repeats : 1); attempt++) {
    await session.goto(subgoal.absolute || `${origin}${subgoal.start}`)
    if (adHoc.length) await delay(1200)
    if (process.argv.includes('--dump')) {
      const first = await session.snapshot()
      const offered = buildActionCandidates(first.snapshot, subgoal.goal, { input: subgoal.input, keys: subgoal.keys, control: subgoal.control })
      for (const candidate of offered) {
        const ref = candidate.action && 'ref' in candidate.action ? String(candidate.action.ref) : ''
        console.log(`     ${candidate.id.padEnd(14)} ${ref ? await session.boxFor(ref) : '(no ref)'}  hit=${ref ? await session.hitFor(ref) : '-'}  ${candidate.description}`)
      }
    }
    const started = Date.now()
    const executor = new BrowserFastExecutor(session, client, resolved, { runId: `live:${subgoal.id}` })
    const result = await executor.execute({
      taskId: 'browser-fast-live',
      browserSessionId: 'live-session',
      goal: subgoal.goal,
      input: subgoal.input,
      keys: subgoal.keys,
      control: subgoal.control,
      plan: subgoal.plan,
      cycles: subgoal.cycles,
      maxRepeat: subgoal.maxRepeat,
      maxUncertainSteps: subgoal.maxUncertainSteps,
      maxSteps: subgoal.maxSteps,
    })
    const page = await session.describe()
    const ok = await subgoal.verify(result, page, session)
    if (!ok) failures += 1
    const label = adHoc.length && repeats > 1 ? `${subgoal.id}#${attempt}` : subgoal.id
    const perDecision = (result.metrics.jevCalls / Math.max(1, result.metrics.browserActions)).toFixed(2)
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label.padEnd(20)} status=${result.status} actions=${result.metrics.browserActions} decisions=${result.metrics.jevCalls} (${perDecision}/action) waits=${result.metrics.waits} wall=${Date.now() - started}ms ${Math.round(result.elapsed_ms / Math.max(1, result.metrics.browserActions))}ms/action`)
    console.log(`     actions: ${result.steps.map(step => `${step.action}@${step.probability?.toFixed(2) ?? '-'}`).join(' → ') || '(none)'}`)
    console.log(`     page:    ${page.url}`)
    if (adHoc.length) console.log(`     page text: ${page.text.replace(/\s+/g, ' ').slice(0, 400)}`)
    if (!ok && result.reason) console.log(`     reason:  ${result.reason}`)
    }
  }

  console.log(`\n${failures ? `${failures} of ${planned.length} subgoals failed` : `all ${planned.length} subgoals driven end to end by the fast path in real Chrome`}`)
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

  static async connect(port, wanted) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    const page = wanted
      ? targets.find(target => target.id === wanted)
      : targets.find(target => target.type === 'page')
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

  /** Evaluates an expression in the page, for geometry and other one-off questions. */
  async evaluate(expression) {
    return this.#evaluate(expression)
  }

  /** The resolved box for a ref, which is what a click's coordinates come from. */
  async boxFor(ref) {
    const backendNodeId = this.#refs.get(String(ref))
    if (!backendNodeId) return 'no-ref'
    const box = await this.send('DOM.getBoxModel', { backendNodeId }).catch(error => ({ error: String(error) }))
    const quad = box?.model?.content || box?.model?.border
    if (!quad) return `no-box${box?.error ? ` (${box.error})` : ''}`
    const w = Math.hypot(quad[2] - quad[0], quad[3] - quad[1])
    const h = Math.hypot(quad[4] - quad[2], quad[5] - quad[3])
    return `${w.toFixed(0)}x${h.toFixed(0)} at (${((quad[0] + quad[2] + quad[4] + quad[6]) / 4).toFixed(0)},${((quad[1] + quad[3] + quad[5] + quad[7]) / 4).toFixed(0)})`
  }

  /**
   * What actually receives a click at a point: the hit test CDP itself would use.
   * A control that is present with a sane box can still sit under a dialog, a
   * banner, or an overlay, and then a click silently does nothing.
   */
  /**
   * Mirrors the bridge's own answer: would a click at this point reach the control?
   * An inconclusive answer stays permissive, exactly as the extension is.
   */
  async reachable(backendNodeId, x, y) {
    const hit = await this.send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true }).catch(() => null)
    if (!hit || hit.backendNodeId === undefined || hit.backendNodeId === backendNodeId) return true
    const [target, under] = await Promise.all([
      this.send('DOM.resolveNode', { backendNodeId }),
      this.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId }),
    ]).catch(() => [])
    if (!target?.object?.objectId || !under?.object?.objectId) return true
    const contained = await this.send('Runtime.callFunctionOn', {
      objectId: target.object.objectId,
      functionDeclaration: 'function (other) { return !!other && (this === other || this.contains(other) || other.contains(this)); }',
      arguments: [{ objectId: under.object.objectId }],
      returnByValue: true,
    }).catch(() => null)
    if (contained?.result?.value !== false) return true
    const described = await this.send('Runtime.callFunctionOn', {
      objectId: under.object.objectId,
      functionDeclaration: 'function () { const label = (this.getAttribute && (this.getAttribute("aria-label") || this.getAttribute("title"))) || ""; const text = (this.textContent || "").trim(); return ((this.tagName || "").toLowerCase() + " " + (label || text).replace(/\\s+/g, " ").slice(0, 60)).trim(); }',
      returnByValue: true,
    }).catch(() => null)
    return { covering: String(described?.result?.value || 'another element').slice(0, 80) }
  }

  async hitFor(ref) {
    const backendNodeId = this.#refs.get(String(ref))
    if (!backendNodeId) return 'no-ref'
    const box = await this.send('DOM.getBoxModel', { backendNodeId }).catch(() => undefined)
    const quad = box?.model?.content || box?.model?.border
    if (!quad) return 'no-box'
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    const hit = await this.send('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false }).catch(error => ({ error: String(error) }))
    if (!hit?.backendNodeId) return `none (${hit?.error || 'no node'})`
    const described = await this.send('DOM.describeNode', { backendNodeId: hit.backendNodeId }).catch(() => undefined)
    const node = described?.node
    if (!node) return String(hit.backendNodeId)
    const attributes = (node.attributes || []).join(' ')
    const same = hit.backendNodeId === backendNodeId ? 'SELF' : 'OTHER'
    return `${same} <${node.nodeName.toLowerCase()} ${attributes.slice(0, 90)}>`
  }

  /** Reads a number the page keeps to itself, which is how a canvas result is checked. */
  async evaluateNumber(expression) {
    const value = Number(await this.#evaluate(expression))
    return Number.isFinite(value) ? value : 0
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
      // The product's extension scrolls the control into view before reading its box,
      // and the page's own viewport can be much shorter than the window: without this
      // the click lands on empty space and silently does nothing.
      try { await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }) } catch {}
      const box = await this.send('DOM.getBoxModel', { backendNodeId }).catch(() => undefined)
      const quad = box?.model?.content || box?.model?.border
      if (quad) {
        const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4
        const reach = await this.reachable(backendNodeId, x, y)
        if (reach !== true) throw new BrowserControlBlockedError(reach.covering)
      }
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
