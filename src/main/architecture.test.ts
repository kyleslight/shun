import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(fileURLToPath(import.meta.url))

test('prompt wording cannot enter capability or hidden execution-policy control flow', async () => {
  const [index, runtime, capabilities] = await Promise.all([
    readFile(join(root, 'index.ts'), 'utf8'),
    readFile(join(root, 'agent-runtime.ts'), 'utf8'),
    readFile(join(root, 'capabilities.ts'), 'utf8'),
  ])

  const indexTextUses = index.split('\n').filter(line => line.includes('req.text'))
  assert.deepEqual(indexTextUses.map(line => line.trim()), [
    "const append = taskEvents.append(req.taskId, { type: 'request', runId: req.id, messageId: req.messageId, text: req.text, attachments: req.attachments, source: req.source, schedule: req.schedule })",
    "const user: Turn = { id: req.messageId!, role: 'user', content: req.text }",
    'const runtimeRequest = toolAttachments.length ? { ...req, text: `${req.text}${attachmentManifest(toolAttachments)}` } : req',
  ])
  const runtimeTextUses = runtime.split('\n').filter(line => line.includes('req.text'))
  assert.deepEqual(runtimeTextUses.map(line => line.trim()), ['await session.prompt(req.text, options.initialImages?.length ? { images: options.initialImages } : undefined)'])
  assert.match(index, /for \(const item of attached\.filter\(item => item\.kind === 'image'\)\)/)
  assert.match(index, /inlineImageIds\.add\(item\.id\)/)
  assert.doesNotMatch(index, /inlineImageNotice|name: 'attachment_view'/)
  assert.match(index, /name: 'attachment_read'[\s\S]*readAttachmentForModel/)
  assert.doesNotMatch(index, /visionEnabled|selectedModel\?\.inputModalities/)
  assert.doesNotMatch(runtime, /const hasImages = req\.attachments/)
  assert.match(runtime, /input: \['text', 'image'\]/)
  assert.match(index, /当前模型或 Provider 不支持图片输入/)
  assert.match(capabilities, /activeToolNames\(productToolNames: string\[\]\)/)
  assert.match(capabilities, /productToolNamesToDefer\(productToolNames: string\[\], hasAttachments: boolean\)/)
  assert.match(index, /const cwd = await taskWorkingDirectory\(req\)/)
  assert.match(index, /agentRuntimeHome\(app\.getPath\('home'\), process\.env\.SHUN_HOME\)/)
  assert.match(index, /migrateLegacyAgentRuntime\(join\(app\.getPath\('userData'\), 'agent-runtime'\), runtimePaths\)/)
  assert.match(index, /const deferredNames = new Set\(productTools\.deferred/)
  assert.match(index, /activeToolNames\(productTools\.tools\.filter/)
  assert.match(index, /productToolNamesToDefer\(definitions\.map\(tool => tool\.name\), Boolean\(req\.attachments\?\.length\)\)/)
  assert.match(runtime, /appendSystemPrompt: \[\.\.\.capabilityPrompt\(sessionActiveTools\), \.\.\.executionStrategyPrompt\(req\.settings\.executionStrategy\)\]/)
  assert.match(capabilities, /executionStrategyPrompt\(strategy: ExecutionStrategy = 'balanced'\)/)
  assert.doesNotMatch(capabilities, /problem_statement|benchmark|instance_id/i)
  assert.match(runtime, /currentlySearchableToolNames\.has\(name\)/)
  assert.match(runtime, /session\.setActiveToolsByName\(\[\.\.\.new Set\(\[\.\.\.sessionActiveTools, \.\.\.restoredDeferredToolNames\]\)\]\)/)
  assert.doesNotMatch(runtime, /const discovered = options\.enableExtensionTools/)
  assert.match(index, /hasTrustRequiringProjectResources\(cwd\)/)
  assert.match(index, /resolveProjectTrust: \(\) => resolveTaskProjectTrust\(cwd\)/)
  assert.match(index, /does not restrict or expand read, write, edit, or shell access/)
  assert.doesNotMatch(capabilities, /\b(?:req|request)\./)
  assert.doesNotMatch(`${index}\n${runtime}`, /selectKernelRoute|workspaceIntent|researchIntent|requestsNoVerification/)
  assert.match(index, /name: 'plugin_view_present'[\s\S]*materially completes the current foreground workflow/)
  assert.match(runtime, /\['plugin_view_present', 'background_start', 'browser_debug', 'browser_preview_act'\]\.includes\(event\.toolName\)[\s\S]*details\?\.pluginView/)
  assert.match(index, /const webResearch = new WebResearchPolicy\(\)/)
  assert.match(index, /outcomePolicy: webResearch/)
  assert.match(index, /name: 'web_search'[\s\S]*site: Type\.Optional[\s\S]*exact_phrases: Type\.Optional/)
  assert.match(index, /searchWeb\(args\.query, args\.max_results, \{ site: args\.site, exactPhrases: args\.exact_phrases, renderPage: renderWebPage, fetchResource: fetchWebResource \}\)/)
  assert.doesNotMatch(index, /toolNeedsApproval|agent:approve|type: 'approval'/)
  assert.doesNotMatch(index, /commandIsDestructive|commandUsesNetworkClient|localNetworkCommandAllowed/)
})

test('hidden research Chromium remains invisible and muted before navigation', async () => {
  const index = await readFile(join(root, 'index.ts'), 'utf8')
  const renderPage = index.slice(index.indexOf('const renderWebPage:'), index.indexOf('const fetchWebResource'))

  assert.match(renderPage, /show: false/)
  assert.match(renderPage, /focusable: false/)
  assert.match(renderPage, /skipTaskbar: true/)
  assert.match(renderPage, /page\.webContents\.setAudioMuted\(true\)/)
  assert.match(renderPage, /media-started-playing/)
  assert.ok(renderPage.indexOf('setAudioMuted(true)') < renderPage.indexOf('page.loadURL('))
})

test('local browser debugging stays an isolated bounded product tool', async () => {
  const [index, preview] = await Promise.all([readFile(join(root, 'index.ts'), 'utf8'), readFile(join(root, 'browser-preview-debug.ts'), 'utf8')])
  const section = index.slice(index.indexOf("name: 'browser_debug'"), index.indexOf('const fetchWebResource'))
  assert.match(section, /inspectLocalPage/)
  assert.match(section, /browserPreviewDebug\.inspect\(sessionId/)
  assert.match(section, /pluginView: browserPreviewRequest\(browserDebugUrl\(args\.url\)\)/)
  assert.doesNotMatch(section, /partition: 'shun-browser-debug'/)
  assert.match(section, /setProxy\(\{ mode: 'direct' \}\)/)
  assert.match(section, /show: false/)
  assert.match(section, /setAudioMuted\(true\)/)
  assert.match(section, /capturePage\(\)/)
  assert.match(section, /type: 'image'/)
  assert.match(section, /slice\(0, 6000\)/)
  assert.match(section, /signal\?\.addEventListener\('abort'/)
  assert.match(section, /status: authRequired \? 'auth_required'/)
  assert.match(preview, /source: 'browser-preview'/)
  assert.match(preview, /console-message[\s\S]*onBeforeRequest[\s\S]*onCompleted/)
  assert.match(preview, /localStorage[\s\S]*PerformanceObserver[\s\S]*capturePreview/)
  assert.match(preview, /Do not retry, refresh, submit credentials/)
})

test('Browser Use controls existing Chrome through a product resource instead of an Electron browser session', async () => {
  const [index, service, manifest, extension, popup, popupPage, packageJson] = await Promise.all([
    readFile(join(root, 'index.ts'), 'utf8'),
    readFile(join(root, 'chrome-browser.ts'), 'utf8'),
    readFile(join(root, '../../resources/browser-use-extension/manifest.json'), 'utf8'),
    readFile(join(root, '../../resources/browser-use-extension/service-worker.js'), 'utf8'),
    readFile(join(root, '../../resources/browser-use-extension/popup.js'), 'utf8'),
    readFile(join(root, '../../resources/browser-use-extension/popup.html'), 'utf8'),
    readFile(join(root, '../../package.json'), 'utf8'),
  ])
  const tools = index.slice(index.indexOf("if (pluginIds.has('browser-use'))"), index.indexOf("if (enabledMcpServers", index.indexOf("if (pluginIds.has('browser-use'))")))
  assert.match(tools, /browser_tabs[\s\S]*browser_claim[\s\S]*browser_open[\s\S]*browser_snapshot[\s\S]*browser_navigate[\s\S]*browser_act[\s\S]*browser_download[\s\S]*browser_download_wait[\s\S]*browser_release/)
  assert.doesNotMatch(tools, /BrowserWindow|loadURL|partition:/)
  assert.doesNotMatch(service, /from 'electron'|BrowserWindow|chromium\.launch|userDataDir/)
  assert.match(service, /WebSocketServer[\s\S]*127\.0\.0\.1/)
  assert.match(service, /taskId[\s\S]*createdByRunId[\s\S]*tabId/)
  assert.match(index, /chromeBrowser\.removeTask\(taskId\)/)
  assert.match(index, /finally\(async \(\) => \{[\s\S]*chromeBrowser\.releaseRun\(sessionId, req\.id\)/)
  assert.match(service, /releaseRun[\s\S]*#releaseSessions\(active, 'suspended'\)/)
  assert.match(service, /snapshot[\s\S]*#persistSnapshot[\s\S]*#releaseSessions\(\[session\], 'suspended'\)/)
  const parsedManifest = JSON.parse(manifest)
  assert.deepEqual(parsedManifest.permissions.sort(), ['alarms', 'debugger', 'downloads', 'tabs'])
  assert.equal(parsedManifest.host_permissions, undefined)
  assert.equal(parsedManifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:*")
  assert.equal(parsedManifest.icons['128'], 'icons/icon-128.png')
  assert.match(extension, /Accessibility\.getFullAXTree/)
  assert.match(extension, /Page\.captureScreenshot/)
  assert.match(extension, /Runtime\.consoleAPICalled/)
  assert.match(extension, /Input\.dispatchMouseEvent/)
  assert.match(extension, /DOM\.setFileInputFiles/)
  assert.match(extension, /downloads\.start/)
  assert.match(extension, /downloads\.wait/)
  assert.doesNotMatch(extension, /Page\.setDownloadBehavior/)
  assert.match(extension, /onclose[\s\S]*releaseAttachedTabs\(\)/)
  assert.match(extension, /chrome\.alarms\.onAlarm[\s\S]*connect\(\)/)
  assert.match(extension, /preferEarlierServer[\s\S]*adoptSocket\(candidate, port\)/)
  assert.match(extension, /connectionAttempt[\s\S]*candidate\.onopen[\s\S]*adoptSocket/)
  assert.match(extension, /message\?\.type === 'connect'[\s\S]*connect\(\)/)
  assert.match(popup, /permission-probe/)
  assert.match(popup, /Approve Chrome’s local network request/)
  assert.match(popupPage, /id="connect"[\s\S]*Connect to Shun/)
  assert.match(service, /permission-probe[\s\S]*socket\.close\(1000/)
  assert.match(index, /process\.resourcesPath, 'browser-use-extension'/)
  assert.match(index, /app\.getPath\('userData'\), 'browser-use-extension'/)
  assert.match(index, /chromeBrowser\.start[\s\S]*syncBundledChromeExtension/)
  assert.match(index, /installedVersion[\s\S]*bundledManifest\.version[\s\S]*cp\(bundledExtensionDir, extensionDir/)
  assert.match(index, /mkdir\(extensionDir, \{ recursive: true \}\)[\s\S]*cp\(bundledExtensionDir, extensionDir, \{ recursive: true, force: true \}\)/)
  assert.doesNotMatch(index, /rm\(extensionDir, \{ recursive: true/)
  assert.deepEqual(JSON.parse(packageJson).build.extraResources, [
    { from: 'resources/browser-use-extension', to: 'browser-use-extension' },
    { from: 'build/ios-simulator-driver', to: 'ios-simulator-driver' },
    { from: 'resources/plugins', to: 'plugins' },
  ])
})

test('installed Skills use bounded progressive disclosure with search and execution tools', async () => {
  const [index, runtime, capabilities] = await Promise.all([
    readFile(join(root, 'index.ts'), 'utf8'),
    readFile(join(root, 'agent-runtime.ts'), 'utf8'),
    readFile(join(root, 'capabilities.ts'), 'utf8'),
  ])

  assert.match(runtime, /new DefaultResourceLoader\([\s\S]*skillsOverride:/)
  assert.match(runtime, /options\.additionalSkills/)
  assert.match(runtime, /createAgentSession\([\s\S]*resourceLoader/)
  assert.doesNotMatch(index, /name: 'installed_skill_(?:list|read)'/)
  assert.match(index, /name: 'skill_create'[\s\S]*managedSkills\(\)\.create\(/)
  assert.match(index, /name: 'skill_update'[\s\S]*managedSkills\(\)\.updateManaged\(/)
  assert.match(index, /name: 'skill_remove'[\s\S]*planSkillRemoval\([\s\S]*managedSkills\(\)\.remove\(/)
  assert.match(index, /name: 'skill_run'/)
  assert.match(index, /skillRunParameters[\s\S]*json_options/)
  assert.match(index, /constrainedSampling: \{ type: 'json_schema', strict: 'prefer' \}/)
  assert.match(index, /managedSkills\(\)[\s\S]*runPython\([\s\S]*jsonOptions: args\.json_options/)
  assert.match(runtime, /name: SKILL_SEARCH_NAME/)
  assert.match(runtime, /MAX_INLINE_SKILLS = 20/)
  assert.match(index, /enabledPluginSkillDocuments\(settings\)/)
  assert.match(index, /loadFirstPartySkills\(app\.getAppPath\(\), selectedSkillIds\)/)
  assert.match(index, /loadSkillsFromDir\(\{ dir: root, source: 'product-plugin' \}\)/)
  assert.match(capabilities, /canonical read tool/)
  assert.match(capabilities, /skill_run owns the isolated runtime/)
})
