import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { pluginViewTestActionScript, pluginViewTestFrameUrl, pluginViewTestHarness, pluginViewTestMarker, pluginViewTestSnapshotScript, pluginViewTestThemeTokens } from './plugin-view-test.ts'

test('plugin view test harness keeps the view in the isolated protocol and authenticates bridge messages', () => {
  const html = pluginViewTestHarness('shun-plugin://example/ui/index.html', 'channel-1', 'secret-1', pluginViewTestThemeTokens('dark'))
  assert.match(html, /sandbox="allow-scripts allow-same-origin"/)
  assert.match(html, /frame-src shun-plugin:/)
  assert.match(html, /shun-plugin:\/\/example\/ui\/index\.html\?channel=channel-1/)
  assert.match(html, new RegExp(pluginViewTestMarker('secret-1')))
  assert.doesNotMatch(html, /Host conversation test fixture/)
  assert.throws(() => pluginViewTestHarness('https://example.com', 'channel', 'secret', pluginViewTestThemeTokens('light')), /isolated plugin protocol/)
})

test('plugin view test exposes one exact initial iframe URL without widening the protocol boundary', () => {
  assert.equal(pluginViewTestFrameUrl('shun-plugin://example/ui/index.html', 'channel 1'), 'shun-plugin://example/ui/index.html?channel=channel+1')
  assert.equal(pluginViewTestFrameUrl('shun-plugin://example/ui/index.html?mode=test', 'channel-2'), 'shun-plugin://example/ui/index.html?mode=test&channel=channel-2')
  assert.throws(() => pluginViewTestFrameUrl('file:///tmp/index.html', 'channel'), /isolated plugin protocol/)
})

test('plugin view test actions serialize selectors and values without script interpolation', () => {
  const click = pluginViewTestActionScript({ type: 'click', selector: '[data-testid="save"]' })
  const fill = pluginViewTestActionScript({ type: 'fill', selector: '#name', value: 'x";globalThis.bad=true;//' })
  assert.match(click, /querySelector\(selector\)/)
  assert.match(fill, /value = "x\\";globalThis\.bad=true;\/\/"/)
  assert.doesNotMatch(fill, /value = x"/)
  assert.throws(() => pluginViewTestActionScript({ type: 'click', selector: '' }), /missing/)
})

test('plugin view test snapshots avoid exposing editable values and provide both themes', () => {
  const snapshot = pluginViewTestSnapshotScript(), dark = pluginViewTestThemeTokens('dark', 'mint'), light = pluginViewTestThemeTokens('light', 'mint')
  assert.doesNotMatch(snapshot, /element\.value/)
  assert.match(snapshot, /horizontal_overflow/)
  assert.notEqual(dark['app-bg'], light['app-bg'])
  assert.equal(dark.accent, light.accent)
})

test('plugin development exposes installed-view testing through the production authorization boundary', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  assert.match(main, /action: Type\.Union\(\[Type\.Literal\('prepare'\), Type\.Literal\('scaffold'\), Type\.Literal\('validate'\), Type\.Literal\('install'\), Type\.Literal\('pack'\), Type\.Literal\('remove'\)\]\)/)
  assert.match(main, /createPluginArchive\(source\)[\s\S]*sha256: archive\.sha256[\s\S]*contentSha256: archive\.contentSha256/)
  assert.match(main, /stagePluginArchive\(await readFile\(safe\(cwd, args\.path\)\)\)[\s\S]*await staged\?\.cleanup\(\)/)
  assert.match(main, /installFromDirectory\(source, staged \? 'marketplace' : 'directory'\)/)
  assert.match(main, /scaffoldPluginPackage/)
  assert.doesNotMatch(main, /primary_flow \|\| !args\.icon_concept/)
  assert.match(main, /phase: 'prepared'/)
  assert.match(main, /Never assume a developer-machine command or the user PATH.*runtime\.executables.*installed worker\/runtime path/)
  assert.match(main, /phase: 'implementation'/)
  assert.match(main, /phase: 'validated'/)
  assert.match(main, /phase: 'installed-test-required'/)
  assert.match(main, /nextAction: \{/)
  assert.match(main, /nextActions: enabled/)
  assert.match(main, /name: 'plugin_package'[\s\S]*constrainedSampling: \{ type: 'json_schema', strict: 'prefer' \}/)
  assert.match(main, /name: 'plugin_view_test'[\s\S]*constrainedSampling: \{ type: 'json_schema', strict: 'prefer' \}/)
  assert.match(main, /pluginDevelopmentWorkspaceState\(req\.settings\.workspace\)/)
  assert.match(main, /workspaceState\.status === 'workspace_required'/)
  assert.match(main, /name: 'plugin_view_test'/)
  assert.match(main, /invokePluginViewCapability\(view\.pluginId, view\.viewId, view\.accessToken, packet\.method, packet\.payload, workspace, view\.boundTaskId, true\)/)
  assert.match(main, /Automated plugin view tests are read-only and block Git mutations/)
  assert.match(main, /Automated plugin view tests block operating-system reveal actions/)
  assert.match(main, /Automated plugin view tests block operating-system open actions/)
  assert.match(main, /Automated plugin view tests block clipboard changes/)
  assert.match(main, /method === 'host\.export'/)
  assert.match(main, /Automated plugin view tests block operating-system export actions/)
  assert.match(main, /properties: \['openDirectory', 'createDirectory'\]/)
  assert.match(main, /method === 'worker\.invoke'/)
  assert.match(main, /runPluginWorker/)
  assert.match(main, /partition: `shun-plugin-view-test-\$\{randomUUID\(\)\}`/)
  assert.match(main, /page\.webContents\.session\.protocol\.handle\('shun-plugin', servePluginAsset\)/)
  assert.match(main, /runtime \? 'public, max-age=31536000, immutable' : 'no-store, max-age=0'/)
  assert.match(main, /details\.url === expectedFrameUrl/)
  assert.match(main, /const failureStage = ready \? undefined : blockedNavigations\.length \? 'navigation-blocked'/)
  assert.match(main, /Do not modify the plugin or compare another plugin/)
  assert.match(main, /Diagnose these installed-view failures, edit the same package, reinstall, and retest/)
  assert.match(main, /page\.webContents\.session\.protocol\.unhandle\('shun-plugin'\)/)
  assert.match(main, /sandbox: true/)
  assert.match(main, /nodeIntegration: false/)
  assert.match(main, /supportFetchAPI: true/)
  assert.match(main, /corsEnabled: true/)
  assert.match(main, /const screenshotSupported = selectedModel\?\.vision !== false/)
  assert.match(main, /screenshot_omitted_reason/)
})

test('publishing is one short conversation the agent can run, with the person typing only an address and a code', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  // The tool surface: status, request_code, verify_code, submit.
  assert.match(main, /action: Type\.Union\(\[Type\.Literal\('status'\), Type\.Literal\('request_code'\), Type\.Literal\('verify_code'\), Type\.Literal\('submit'\)\]\)/)
  // The code is asked for in conversation and verified by the tool.
  assert.match(main, /plugin_publish action=verify_code requires the code the user gave you/)
  assert.match(main, /identity\.verify\(\{ challengeId: \(await identity\.pendingChallenge\(\)\) \|\| '', code: String\(args\.code\)\.trim\(\)/)
  // An immutable version is explained rather than retried blindly — in one sentence, without field names.
  assert.match(main, /status: 'version_exists'[\s\S]*versions cannot be replaced[\s\S]*submit again/)
  // A refused identity is cleared so the next attempt re-binds instead of looping.
  assert.match(main, /if \(response\.status === 401\) \{[\s\S]*await identity\.unbind\(\)[\s\S]*status: 'identity_expired'/)
  // Publishing goes through the same verified, signed path as every other upload.
  assert.match(main, /identity\.authorization\('POST', '\/v1\/publish', multipart\.body\)/)
  // The person asked for their plugin to ship; a digest, a file count, a device id,
  // a status table, or an install link is not part of that answer.
  const result = main.slice(main.indexOf("status: payload.status === 'published' ? 'published' : 'submitted'"), main.indexOf("status: payload.status === 'published' ? 'published' : 'submitted'") + 900)
  assert.match(result, /Say it is published and that \$\{inspected\.name\} is in the marketplace now\. One short sentence/)
  assert.doesNotMatch(result, /contentSha256|installLink|fileCount|deviceId|sha256/)
  assert.doesNotMatch(main, /installLink: `shun:\/\/plugin\/\$\{payload\.id\}`/)
})

test('publishing tells the agent the capability exists, and to speak like a person', async () => {
  const skill = await readFile(new URL('../../skills/shun-plugin-development/SKILL.md', import.meta.url), 'utf8')
  // The publish tool is deferred, so an unsearched tool list is not evidence that
  // the client cannot publish it — the mistake this rule exists to prevent.
  assert.match(skill, /`plugin_publish` is a deferred tool[\s\S]*Discover it before you decide anything/)
  assert.match(skill, /Never tell the person the client cannot publish, and never conclude that a capability is missing from a list you have not searched/)
  // Two questions, then one sentence, with none of the pipeline in it.
  assert.match(skill, /Publishing is two questions and then one sentence/)
  assert.match(skill, /No digests, file counts, byte sizes, manifest or version fields, device identities, status tables, review talk, or install links/)
  assert.match(skill, /A publisher the registry trusts goes straight to the store; anyone else waits for the operator/)
})
