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
// A smoke browser must never compete with the person's real extension. Only
// the test copy knows this ephemeral port; production copies scan fixed ports.
const service = new ChromeBrowserService(storageFile, { ports: [0] })
const uploadFile = join(profileDir, 'upload-sample.txt')
const server = createServer((request, response) => {
  if (request.url === '/delayed-transition') {
    setTimeout(() => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Transition confirmed') }, 180)
    return
  }
  if (request.url === '/download') {
    response.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="download-sample.txt"' })
    response.end('Downloaded by Shun Browser Use')
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><html><body>
    <h1 id="status">Ready for Shun</h1>
    <a href="/observed-signout?fixture-token=synthetic#fragment" style="display:inline-block;width:32px;height:32px" onclick="event.preventDefault();window.iconClicks=(window.iconClicks||0)+1;document.querySelector('#icon-status').textContent='Icon action '+window.iconClicks"><span aria-hidden="true">↪</span></a><p id="icon-status">Icon untouched</p>
    <figure id="profile-control" style="cursor:pointer;width:40px;height:40px"><span id="profile-trigger"><img alt="Smoke profile" width="40" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='blue'/%3E%3C/svg%3E"></span></figure>
    <figure><img alt="Static illustration" width="40" height="40" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'/%3E"></figure><p id="profile-status">Profile closed</p>
    <button onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#status').textContent = 'Clicked by Shun '+window.clicks">Change heading</button>
    <button onclick="if(event.isTrusted &amp;&amp; document.hasFocus()){window.trustedClicks=(window.trustedClicks||0)+1;document.querySelector('#trusted-status').textContent='Trusted background '+window.trustedClicks}else{document.querySelector('#trusted-status').textContent='Untrusted input refused'}">Trusted background action</button><p id="trusted-status">Trusted input pending</p>
    <label>Browser input <input aria-label="Browser input"></label>
    <button onclick="fetch('/delayed-transition').then(r=>r.text()).then(text=>document.querySelector('#transition-status').textContent=text)">Delayed transition</button><p id="transition-status">Transition pending</p>
    <form onsubmit="event.preventDefault();window.submissions=(window.submissions||0)+1;document.querySelector('#form-status').textContent='Submitted '+window.submissions">
      <label>Account email <input type="email" aria-label="Account email"></label>
      <label>Display name <input aria-label="Display name"></label>
      <label>Region <select aria-label="Region"><option value="">Choose</option><option value="CN">China</option></select></label>
      <button type="submit">Sign in</button><p id="form-status">Not submitted</p>
    </form>
    <label>Location <input aria-label="Location" value="San Jose"></label>
    <label>Language <input aria-label="Language" role="combobox" aria-autocomplete="list" aria-controls="languages" oninput="document.querySelector('#languages').hidden=false"></label>
    <div id="languages" role="listbox" hidden><div role="option" onclick="document.querySelector('#chosen-language').textContent='Selected language: English';document.querySelector('[aria-label=Language]').value='';this.parentElement.hidden=true">English</div></div>
    <p id="chosen-language">No language selected</p>
    <label>Redirected input <input aria-label="Redirected input" onfocus="document.querySelector('[aria-label=Location]').focus()"></label>
    <label>Controlled input <input aria-label="Controlled input" oninput="document.querySelector('#controlled-status').textContent=event.isTrusted?'Accepted controlled value: '+this.value:'Synthetic input refused'"></label><p id="controlled-status">Controlled input pending</p>
    <input type="file" aria-label="Upload sample">
    <span id="upload-proxy" role="button" tabindex="0" aria-label="Choose a file" style="display:inline-block;padding:6px 10px;border:1px solid #888">Choose a file<input type="file" id="upload-hidden" aria-label="Hidden upload" style="display:none"></span>
    <div id="proxy-status">no file chosen</div>
    <div id="sibling-wrapper" style="padding:4px;border:1px dashed #aaa">
      <button id="sibling-proxy" type="button">Choose a file (side by side)</button>
      <input type="file" id="sibling-hidden" aria-label="Sibling upload" style="display:none">
    </div>
    <div id="sibling-status">no file chosen</div>
    <div role="dialog" aria-label="Account confirmation">
      <input type="file" aria-label="Unrelated avatar upload" style="display:none">
      <button type="button">Cancel account action</button>
      <button type="button" onclick="window.accountActions=(window.accountActions||0)+1;document.querySelector('#account-status').textContent='Account action '+window.accountActions">Confirm account action</button>
      <p id="account-status">Account untouched</p>
    </div>
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
      document.addEventListener('click', event => {
        if (event.target.closest('#profile-trigger')) { window.profileClicks=(window.profileClicks||0)+1;document.querySelector('#profile-status').textContent='Profile opened '+window.profileClicks }
      })
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
  await writeFile(workerPath, worker.replace("const PORTS = Array.from({ length: 10 }, (_, index) => 32124 + index)", `const PORTS = [${bridgePort}]`).replace('usePage = containsExtensionFrame(tree?.frameTree)', "usePage = containsExtensionFrame(tree?.frameTree) || new URL((await tabsGet(tabId)).url).searchParams.has('isolated-smoke')").replace('if (!stablePageTabs.has(tabId)) {', "if (!stablePageTabs.has(tabId) || new URL((await tabsGet(tabId)).url).searchParams.has('isolated-smoke')) {"))
  const headMode = process.env.SHUN_CHROME_HEADFUL === '1' ? [] : ['--headless=new']
  const chromeStartedAt = Date.now()
  chromeProcess = spawn(chrome, [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${isolatedExtensionDir}`,
    `--disable-extensions-except=${isolatedExtensionDir}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch,LocalNetworkAccessChecks',
    ...headMode,
    '--use-mock-keychain',
    '--password-store=basic',
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

  await requestTestExtensionConnection(profileDir)
  await waitFor(() => service.state().connected, 45_000, 'Chrome extension did not connect to the Shun loopback bridge.')
  console.log(`connected: bridge port ${bridgePort}; cold startup ${Date.now() - chromeStartedAt} ms`)

  const observationUrl = process.argv.find(arg => arg.startsWith('--observation-url='))?.slice('--observation-url='.length)
  if (observationUrl) {
    const observed = await service.open('observation-smoke', 'observation-run', observationUrl)
    for (let index = 0; index < 6; index++) {
      try {
        const frame = await service.snapshot('observation-smoke', observed.id, false)
        console.log(JSON.stringify({ observation: index + 1, state: frame.snapshot.readyState, nodes: frame.snapshot.nodes?.length, url: frame.snapshot.tab.url }))
      } catch (error) {
        console.log(JSON.stringify({ observation: index + 1, error: String(error), cause: error.cause }))
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 700))
    }
    await service.removeTask('observation-smoke')
  }

  // Exercise the real isolated-world path too, without sharing a profile or bridge
  // with the person's browser. Only this temporary extension forces the transport.
  const pageSession = await service.open('page-smoke-task', 'page-smoke-run', targetUrl + '?isolated-smoke=1')
  let pageFrame = await service.snapshot('page-smoke-task', pageSession.id, false)
  if (pageFrame.snapshot.transport !== 'page') throw Error('Isolated smoke did not select the page transport.')
  const profile = pageFrame.snapshot.nodes.find(node => node.role === 'button' && node.name === 'Smoke profile')
  if (!profile || pageFrame.snapshot.nodes.some(node => node.name === 'Static illustration')) throw Error('The image control was not distinguished from a static illustration.')
  pageFrame = await service.act('page-smoke-task', pageSession.id, { action: 'click', ref: profile.ref })
  if (!pageFrame.snapshot.text.includes('Profile opened 1') || pageFrame.snapshot.text.includes('Profile opened 2')) throw Error('Delegated image control did not open exactly once.')
  console.log('image control: labelled delegated profile opens once; static illustration excluded')
  const email = pageFrame.snapshot.nodes.find(node => node.name === 'Account email')
  pageFrame = await service.act('page-smoke-task', pageSession.id, { action: 'fill', fields: [{ ref: email.ref, text: 'smoke@example.test' }] })
  const pageFill = JSON.parse(pageFrame.text)
  if (pageFill.form.status !== 'completed') throw Error('Isolated field value was not verified.')
  if (typeof pageFill.page !== 'object' || pageFill.page.input_delivery?.type !== 'synthetic') throw Error('Synthetic field results lost their structured page or delivery evidence.')
  const submit = pageFrame.snapshot.nodes.find(node => node.name === 'Sign in')
  pageFrame = await service.act('page-smoke-task', pageSession.id, { action: 'click', ref: submit.ref })
  if (!pageFrame.snapshot.text.includes('Submitted 1') || pageFrame.snapshot.text.includes('Submitted 2')) throw Error('Isolated click did not submit a real form exactly once.')
  await service.removeTask('page-smoke-task')
  console.log('isolated form: actual field verified and real submit event fired exactly once')

  const observer = await service.open('browser-smoke-observer', 'browser-smoke-run', targetUrl + '?observer=1', true)
  const session = await service.open('browser-smoke-task', 'browser-smoke-run', targetUrl)
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
  if (!capture.snapshot.text?.includes('Clicked by Shun 1') || capture.snapshot.text?.includes('Clicked by Shun 2')) throw new Error('Chrome click action did not update the page exactly once.')
  console.log('click: page state updated')
  const delayed = capture.snapshot.nodes.find(node => node.name === 'Delayed transition')
  capture = await service.act('browser-smoke-task', session.id, { action: 'click', ref: delayed.ref })
  if (!capture.snapshot.text.includes('Transition confirmed') && !capture.snapshot.loading) throw Error('An unfinished action-triggered request was reported ready before its transition.')
  console.log('async transition: current content confirmed or loading reported, no click replay')

  capture = await service.act('browser-smoke-task', session.id, { action: 'type', ref: input.ref, text: 'Shun controls Chrome' })
  const updatedInput = capture.snapshot.nodes?.find(node => node.role === 'textbox' && node.name === 'Browser input')
  if (updatedInput?.value !== 'Shun controls Chrome') throw new Error('Chrome type action did not update the input value.')
  console.log('type: input value updated')

  const fields = ['Account email', 'Display name', 'Region'].map(name => {
    const node = capture.snapshot.nodes?.find(node => node.name === name && ['textbox', 'combobox'].includes(node.role))
    if (!node?.ref) throw Error(`Missing observed form field: ${name}`)
    return name === 'Region' ? { ref: node.ref, action: 'select', value: 'CN' } : { ref: node.ref, text: name === 'Account email' ? 'synthetic@example.test' : 'Synthetic researcher' }
  })
  const formStarted = Date.now()
  capture = await service.act('browser-smoke-task', session.id, { action: 'fill', fields })
  const filled = JSON.parse(capture.text).form
  if (filled?.status !== 'completed' || filled.completed_refs.length !== 3 || filled.submitted !== false) throw Error('Form fill did not confirm three fields without submission.')
  const emailField = capture.snapshot.nodes?.find(node => node.name === 'Account email' && node.role === 'textbox')
  const nameField = capture.snapshot.nodes?.find(node => node.name === 'Display name' && node.role === 'textbox')
  const regionField = capture.snapshot.nodes?.find(node => node.name === 'Region' && node.role === 'combobox')
  if (emailField?.value !== 'synthetic@example.test' || nameField?.value !== 'Synthetic researcher' || regionField?.value !== 'China') throw Error('Form values did not survive real browser input events.')
  if (!capture.snapshot.text?.includes('Not submitted') || capture.snapshot.text?.includes('Submitted')) throw Error('Form fill unexpectedly submitted the form.')
  console.log(`form fill: three real fields in one caller step, ${Date.now() - formStarted} ms; values checked, no submission`)

  let invalidOptionRefusal = ''
  try { await service.act('browser-smoke-task', session.id, { action: 'select', ref: regionField.ref, value: 'missing-option' }) }
  catch (error) { invalidOptionRefusal = String(error) }
  if (!invalidOptionRefusal) throw Error('A nonexistent native option was not refused.')
  capture = await service.snapshot('browser-smoke-task', session.id, false)
  if (capture.snapshot.nodes.find(node => node.name === 'Region' && node.role === 'combobox')?.value !== 'China') throw Error('A refused option cleared the existing selection.')
  console.log('native select: nonexistent option refused without clearing the previous selection')

  const language = capture.snapshot.nodes.find(node => node.name === 'Language' && node.role === 'combobox')
  capture = await service.act('browser-smoke-task', session.id, { action: 'fill', fields: [{ ref: language.ref, text: 'English' }] })
  const pendingChoice = JSON.parse(capture.text).form
  if (pendingChoice.status !== 'stopped' || !/explicit option selection/.test(pendingChoice.reason)) throw Error('Autocomplete query was incorrectly reported as a committed selection.')
  if (capture.snapshot.nodes.find(node => node.name === 'Location' && node.role === 'textbox')?.value !== 'San Jose') throw Error('Language input changed the location field.')
  const option = capture.snapshot.nodes.find(node => node.role === 'option' && node.name === 'English')
  if (!option) throw Error('Autocomplete did not expose a fresh named option.')
  capture = await service.act('browser-smoke-task', session.id, { action: 'click', ref: option.ref })
  if (!capture.snapshot.text.includes('Selected language: English')) throw Error('Autocomplete selection was not committed.')
  console.log('autocomplete: query stopped for explicit selection; exact option chosen, location preserved')
  const iconAction = capture.snapshot.nodes.find(node => node.role === 'link' && node.target === '/observed-signout')
  if (!iconAction) throw Error('An unnamed icon link did not expose its observed destination.')
  capture = await service.act('browser-smoke-task', session.id, { action: 'click', ref: iconAction.ref })
  if (!capture.snapshot.text.includes('Icon action 1')) throw Error('The observed icon action did not run exactly once.')
  console.log('link metadata: an unnamed icon exposed its exact destination and clicked once without copying its signed query')


  const accountAction = capture.snapshot.nodes.find(node => node.name === 'Confirm account action' && node.role === 'button')
  if (!accountAction) throw Error('Account confirmation control was omitted.')
  capture = await service.act('browser-smoke-task', session.id, { action: 'click', ref: accountAction.ref })
  if (!capture.snapshot.text.includes('Account action 1')) throw Error('An unrelated hidden upload prevented the account action or it ran more than once.')
  console.log('upload scope: unrelated account confirmation clicked once despite a hidden file input in its dialog')


  const activeTab = (await service.tabs()).find(tab => tab.active)
  if (activeTab?.id !== observer.tabId) throw Error('Background browser actions changed the selected tab.')
  console.log('background: selected observer tab preserved across clicks, typing, form fill, and option selection')

  capture = await service.snapshot('browser-smoke-task', session.id, false)
  const trustedBackground = capture.snapshot.nodes.find(node => node.name === 'Trusted background action')
  if (!trustedBackground) throw Error('Trusted-background fixture is missing.')
  capture = await service.act('browser-smoke-task', session.id, { action: 'click', ref: trustedBackground.ref })
  if (!capture.snapshot.text.includes('Trusted background 1') || capture.snapshot.text.includes('Trusted background 2') || capture.snapshot.text.includes('Untrusted input refused')) throw Error('Background input was not trusted and focused exactly once.')
  if ((await service.tabs()).find(tab => tab.active)?.id !== observer.tabId) throw Error('Trusted background action changed the selected tab.')
  console.log('trusted background: one native browser click, document focus emulated, selected observer tab preserved')

  // Explicitly show only this isolated test tab to exercise native input focus checks.
  await service.show('browser-smoke-task', session.id)
  capture = await service.snapshot('browser-smoke-task', session.id, false)
  const redirected = capture.snapshot.nodes.find(node => node.name === 'Redirected input' && node.role === 'textbox')
  let focusRefusal = ''
  try { await service.act('browser-smoke-task', session.id, { action: 'type', ref: redirected.ref, text: 'English' }) }
  catch (error) { focusRefusal = String(error) }
  if (!/retain focus/.test(focusRefusal)) throw Error('Redirected input focus was not refused.')
  capture = await service.snapshot('browser-smoke-task', session.id, false)
  if (capture.snapshot.nodes.find(node => node.name === 'Location' && node.role === 'textbox')?.value !== 'San Jose') throw Error('Redirected focus corrupted the location field.')
  console.log('focus: redirected input refused before inserting text; existing location preserved')

  const controlled = capture.snapshot.nodes.find(node => node.name === 'Controlled input' && node.role === 'textbox')
  if (!controlled?.ref?.startsWith('p:')) throw Error('Controlled-input test requires a stable main-frame field ref.')
  capture = await service.act('browser-smoke-task', session.id, { action: 'type', ref: controlled.ref, text: 'accepted once' })
  if (!capture.snapshot.text.includes('Accepted controlled value: accepted once') || capture.snapshot.text.includes('Synthetic input refused')) throw Error('The controlled field did not accept browser-delivered input.')
  console.log('controlled input: stable field ref receives trusted browser input with retained focus')

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

// A fresh headless profile has no popup to request its first connection. Use
// the installed extension's own connect entry point, once, before page testing.
async function requestTestExtensionConnection(userDataDir) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    let target
    try {
      const [port] = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then(response => response.json())
      target = targets.find(candidate => candidate.type === 'service_worker' && candidate.url === 'chrome-extension://gdnbifehjpmpkhngchhjiiijikgokfdh/service-worker.js')
    } catch {}
    if (target) {
      await protocolCall(target.webSocketDebuggerUrl, 'Runtime.runIfWaitingForDebugger', {})
      const ready = await evaluate(target.webSocketDebuggerUrl, `Boolean(globalThis.chrome?.runtime?.getManifest && typeof connect === 'function')`).catch(() => false)
      if (!ready) { await delay(100); continue }
      await evaluate(target.webSocketDebuggerUrl, `(() => { if (chrome.runtime.getManifest().name !== 'Shun Browser Use') throw Error('Unexpected test extension'); connect(true); return 'Connection requested'; })()`)
      console.log('bootstrap: requested the installed test extension connection once')
      return
    }
    await delay(100)
  }
  throw Error('The isolated test extension worker did not start within its bootstrap deadline.')
}

async function printChromeDiagnostics(userDataDir) {
  try {
    const [port] = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
    console.error('Chrome DevTools targets:', targets.map(target => JSON.stringify({ type: target.type, title: target.title, url: target.url })).join(', ') || '(none)')
    for (const target of targets.filter(target => target.type === 'service_worker')) {
      const manifest = await evaluate(target.webSocketDebuggerUrl, 'chrome.runtime.getManifest()').catch(error => {
        console.error('Chrome worker inspection failed:', target.url, String(error))
        return undefined
      })
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

function protocolCall(webSocketUrl, method, params) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(webSocketUrl)
    const timer = setTimeout(() => { socket.close(); rejectPromise(new Error('Test-worker protocol request timed out.')) }, 2000)
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method, params })))
    socket.on('message', value => {
      const message = JSON.parse(value.toString())
      if (message.id !== 1) return
      clearTimeout(timer); socket.close()
      if (message.error) rejectPromise(Error('Test-worker protocol request refused.'))
      else resolvePromise(message.result)
    })
    socket.once('error', error => { clearTimeout(timer); rejectPromise(error) })
  })
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
      if (message.error || message.result?.exceptionDetails) {
        rejectPromise(new Error(JSON.stringify(message.error || message.result.exceptionDetails)))
        return
      }
      resolvePromise(message.result?.result?.value)
    })
    socket.once('error', error => { clearTimeout(timer); rejectPromise(error) })
  })
}
