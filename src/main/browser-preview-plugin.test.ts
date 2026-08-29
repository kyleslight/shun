import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { parseHTML } from 'linkedom'
import { validatePluginPackage } from './plugin-packages.ts'

const pluginRoot = new URL('../../resources/plugins/browser-preview/', import.meta.url)

test('built-in browser preview is a transient local-endpoint view without filesystem permissions', async () => {
  const manifest = validatePluginPackage(JSON.parse(await readFile(new URL('manifest.json', pluginRoot), 'utf8')), 'builtin')
  assert.equal(manifest.id, 'browser-preview')
  assert.deepEqual(manifest.permissions, [])
  assert.equal(manifest.runtime?.workspace, 'optional')
  assert.equal(manifest.contributes?.views?.[0].rail, 'transient')
  assert.deepEqual(manifest.contributes?.views?.[0].activation, { localEndpoints: true })
})

test('browser preview uses an isolated browser guest so HTTP(S) pages are not subject to iframe blocking', async () => {
  const [html, app, css, icon, host, hostCss, renderer, main, runtime] = await Promise.all([
    readFile(new URL('ui/index.html', pluginRoot), 'utf8'),
    readFile(new URL('ui/app.js', pluginRoot), 'utf8'),
    readFile(new URL('ui/styles.css', pluginRoot), 'utf8'),
    readFile(new URL('assets/icon.svg', pluginRoot), 'utf8'),
    readFile(new URL('../renderer/src/plugin-view-host.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/plugin-view-host.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('index.ts', import.meta.url), 'utf8'),
    readFile(new URL('agent-runtime.ts', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(html, /Content-Security-Policy|frame-src/)
  assert.match(icon, /<circle cx="12" cy="12" r="8\.5"[^>]*#96999E/)
  assert.match(icon, /#D0D1D3[\s\S]*#96999E/)
  assert.doesNotMatch(icon, /<rect|m10\.25 11\.15 4\.75 2\.85/)
  assert.match(app, /\['http:', 'https:'\]\.includes\(url\.protocol\)/)
  assert.doesNotMatch(app, /allowedHosts|only opens localhost|仅打开 localhost/)
  assert.match(app, /<div id="preview-frame" aria-hidden="true"><\/div>/)
  assert.doesNotMatch(app, /<iframe id="preview-frame"/)
  assert.match(app, /data-action="back"[\s\S]*data-action="forward"[\s\S]*data-action="refresh"/)
  assert.match(app, /data-action="external"[\s\S]*Open in default browser[\s\S]*icons\.external/)
  assert.match(app, /name === 'external'[\s\S]*globalThis\.open\(normalizeUrl\(state\.draft \|\| state\.url\), '_blank', 'noopener,noreferrer'\)/)
  assert.match(app, /loading: '<svg class="loading"[\s\S]*<circle cx="12" cy="12" r="7\.5"/)
  assert.doesNotMatch(app, /state\.loading \? icons\.refresh\.replace/)
  assert.match(css, /\.address button svg[^{]*\{[^}]*transform-box: view-box[^}]*transform-origin: 50% 50%/)
  assert.match(app, /M3\.5 15\.5h17M9 12l3-3 3 3/)
  assert.match(app, /data-action="debug"[\s\S]*data-action="fullscreen"/)
  assert.match(app, /sendBrowserCommand\(\{ type: 'fullscreen', active: !state\.fullscreen \}\)/)
  assert.match(host, /command\.type === 'fullscreen'[\s\S]*setBrowserMaximized\(active\)[\s\S]*sendBrowserEvent\(\{ fullscreen: active \}\)/)
  assert.doesNotMatch(host, /requestFullscreen\(|document\.exitFullscreen\(|fullscreenchange/)
  assert.match(host, /event\.key !== 'Escape'[\s\S]*setBrowserMaximized\(false\)/)
  assert.doesNotMatch(host, /allowFullScreen|clipboard-write; fullscreen/)
  assert.match(hostCss, /\.plugin-view-host\.is-window-maximized[^{]*\{[^}]*position: fixed[^}]*inset: 0[^}]*width: 100vw !important[^}]*z-index: 220/)
  assert.match(hostCss, /\.plugin-view-host\.is-window-maximized\.is-mac-window \.plugin-view-host-header[^{]*\{[^}]*padding-left: 88px/)
  assert.match(css, /\.toolbar button\.fullscreen-toggle \{ margin-left: 9px; \}/)
  assert.match(app, /desktop: \{ width: 1440, height: 900, label: 'Desktop', fluid: true \}[\s\S]*tablet: \{ width: 768, height: 1024[\s\S]*phone: \{ width: 390, height: 844/)
  assert.match(app, /state\.viewport\.fluid[\s\S]*wrap\.style\.width = '100%'; wrap\.style\.height = '100%'/)
  assert.match(css, /\.desktop-fluid \.stage[^{]*\{[^}]*padding: 0[^}]*background: var\(--bg\)/)
  assert.match(css, /\.viewport\.fluid[^{]*\{[^}]*width: 100%[^}]*height: 100%[^}]*transform: none/)
  assert.match(app, /sendBrowserCommand\(\{ type: 'back' \}\)[\s\S]*sendBrowserCommand\(\{ type: 'forward' \}\)/)
  assert.match(app, /navigationKey: 0/)
  assert.match(app, /if \(!root\.querySelector\('\.browser-preview'\)\) root\.innerHTML/)
  assert.match(app, /function syncFrameNavigation\(\)[\s\S]*if \(frame\.dataset\.navigationKey === navigationKey\) return[\s\S]*sendBrowserCommand\(\{ type: 'navigate', url: state\.url, navigationKey \}\)/)
  assert.doesNotMatch(app, /replaceWith\(existingFrame\)|preserveFrame|frameSource/)
  assert.match(app, /name === 'refresh'[^{]*\{[^}]*sendBrowserCommand\(\{ type: 'refresh' \}\)/)
  assert.match(app, /state\.authRequired = null; state\.navigationKey\+\+/)
  assert.match(css, /\.viewport[^{]*\{[^}]*width: var\(--viewport-width\)[^}]*height: var\(--viewport-height\)[^}]*transform: scale\(var\(--viewport-scale\)\)/)
  assert.match(app, /browser\.attach[\s\S]*browser\.diagnostics[\s\S]*browser\.resume/)
  assert.match(app, /Console[\s\S]*Network[\s\S]*Storage[\s\S]*Performance/)
  assert.match(app, /Sign-in required[\s\S]*The agent is paused/)
  assert.match(host, /event: 'resource\.open'/)
  assert.match(host, /view\.pluginId === 'browser-preview'[\s\S]*allow-popups-to-escape-sandbox/)
  assert.match(host, /const BrowserGuest = 'webview' as any[\s\S]*partition="persist:shun-browser-preview"/)
  assert.match(host, /message\.type === 'browser\.command'[\s\S]*runBrowserCommand/)
  assert.match(host, /sendBrowserEvent[\s\S]*did-stop-loading/)
  assert.match(renderer, /activation\?\.localEndpoints[\s\S]*pluginResourceTargets/)
  assert.match(renderer, /openBrowserPreview\(previewEndpoint, task, true\)\.then\(\(opened\) => \{[\s\S]*if \(live && opened\) autoPresentedResourceViews\.current\.add\(previewActivationKey\)/)
  assert.doesNotMatch(renderer, /autoPresentedResourceViews\.current\.add\(previewActivationKey\);\s*void openBrowserPreview/)
  assert.match(renderer, /request\.resource\?\.url && view\.activation\?\.localEndpoints[\s\S]*openBrowserPreview\(request\.resource\.url, target, true\)/)
  assert.match(renderer, /activePluginView && activePluginView\.rail !== "transient"/)
  assert.match(renderer, /plugin-view-card-external[\s\S]*window\.open\(externalUrl, "_blank", "noopener,noreferrer"\)/)
  assert.match(renderer, /plugin-view-card-actions[\s\S]*<Eye \/><span>Preview<\/span>/)
  assert.match(renderer, /plugin-view-card-address[\s\S]*title=\{externalUrl\}[\s\S]*\{externalUrl\}/)
  assert.match(renderer, /plugin-view-card-copy[\s\S]*void copy\(externalUrl\)/)
  assert.match(renderer, /presentPluginViewRequest[\s\S]*request\.resource\?\.url && view\.activation\?\.localEndpoints && task[\s\S]*openBrowserPreview\(request\.resource\.url, task/)
  assert.match(hostCss, /\.plugin-view-card-address-row[^{]*\{[^}]*display: flex/)
  assert.match(hostCss, /\.plugin-view-card-actions[^{]*\{[^}]*border-left[^}]*display: flex/)
  assert.match(hostCss, /\.plugin-view-card-actions svg[^{]*\{[^}]*width: 13px;[^}]*height: 13px/)
  assert.match(hostCss, /\.plugin-view-card-external[^{]*\{[^}]*display: flex/)
  assert.match(hostCss, /\.plugin-view-card\.has-resource[^{]*\{[^}]*width: min\(620px/)
  assert.match(main, /browserPreviewRequest\(browserDebugUrl\(args\.url\)\)/)
  assert.match(main, /task\.endpoints\[0\] \? browserPreviewRequest\(task\.endpoints\[0\]\)/)
  assert.match(main, /webviewTag: true/)
  assert.match(main, /will-attach-webview[\s\S]*persist:shun-browser-preview[\s\S]*delete webPreferences\.preload[\s\S]*webPreferences\.sandbox = true/)
  assert.match(main, /did-attach-webview[\s\S]*guest\.setWindowOpenHandler/)
  assert.match(main, /window\.webContents\.setWindowOpenHandler[\s\S]*shell\.openExternal\(url\)/)
  assert.match(runtime, /\['plugin_view_present', 'background_start', 'browser_debug', 'browser_preview_act'\]\.includes\(event\.toolName\)/)
})

test('browser preview diagnostics never replace or reload the live page frame', async () => {
  const source = await readFile(new URL('ui/app.js', pluginRoot), 'utf8')
  const { window } = parseHTML('<!doctype html><html><body><div id="app"></div></body></html>')
  const posted: Array<Record<string, any>> = []
  const externalOpens: unknown[][] = []
  Object.assign(window, {
    location: { search: '?channel=frame-lifecycle' },
    parent: { postMessage: (message: Record<string, any>) => posted.push(message) },
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (callback: () => void) => { callback(); return 1 },
    setTimeout: () => 1,
    open: (...args: unknown[]) => { externalOpens.push(args); return null },
    URL,
    URLSearchParams,
  })
  vm.runInContext(source, vm.createContext(window))
  const message = (data: Record<string, any>) => {
    const event = new window.Event('message') as Event & { data: Record<string, any> }
    event.data = data
    window.dispatchEvent(event)
  }
  message({ source: 'shun-host', channel: 'frame-lifecycle', type: 'context', context: { language: 'en', theme: 'dark' } })
  message({ source: 'shun-host', channel: 'frame-lifecycle', type: 'event', event: 'resource.open', payload: { url: 'http://localhost:8765/quicksort.html', requestId: 'open-1' } })
  const frame = window.document.querySelector('#preview-frame')
  assert.ok(frame)
  assert.equal(posted.filter(message => message.type === 'browser.command' && message.command?.type === 'navigate').length, 1)
  const external = window.document.querySelector('[data-action="external"]')
  assert.ok(external)
  external.dispatchEvent(new window.Event('click'))
  assert.deepEqual(externalOpens, [['http://localhost:8765/quicksort.html', '_blank', 'noopener,noreferrer']])

  message({ source: 'shun-host', channel: 'frame-lifecycle', type: 'event', event: 'resource.open', payload: { url: 'http://localhost:8765/quicksort.html', requestId: 'open-2' } })
  assert.equal(window.document.querySelector('#preview-frame'), frame)
  assert.equal(posted.filter(message => message.type === 'browser.command' && message.command?.type === 'navigate').length, 1)

  const debug = window.document.querySelector('[data-action="debug"]')
  assert.ok(debug)
  debug.dispatchEvent(new window.Event('click'))
  assert.equal(window.document.querySelector('#preview-frame'), frame)
  const diagnosticsRequest = posted.findLast(message => message.type === 'request' && message.method === 'browser.diagnostics')
  assert.ok(diagnosticsRequest)
  message({ source: 'shun-host', channel: 'frame-lifecycle', type: 'response', requestId: diagnosticsRequest.requestId, result: { console: [], network: [{ status: 200, url: 'http://localhost:8765/quicksort.html', method: 'GET', resourceType: 'subFrame' }] } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(window.document.querySelector('#preview-frame'), frame)
  assert.equal(posted.filter(message => message.type === 'browser.command' && message.command?.type === 'navigate').length, 1)
})
