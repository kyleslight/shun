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
  assert.match(runtime, /appendSystemPrompt: \[\.\.\.capabilityPrompt\(promptToolNames, \{ workspaceSelected: Boolean\(req\.settings\.workspace\) \}\), \.\.\.executionStrategyPrompt\(req\.settings\.executionStrategy\)\]/)
  // Guidance and the provider request share one boundary. A capability is described
  // exactly when it is callable, so the agent's map cannot name a tool the same
  // request cannot call. Widening this to every registered tool is the regression
  // that made the agent plan around capabilities it did not have.
  assert.match(runtime, /const promptToolNames = sessionActiveTools/)
  assert.doesNotMatch(runtime, /guidanceToolNames/)
  assert.doesNotMatch(index, /guidanceToolNames/)
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
  assert.match(runtime, /\['plugin_view_present', 'background_start', 'browser_debug', 'browser_preview_act', 'sites_publish', 'sites_access', 'sites_delete', 'sites_setup'\]\.includes\(event\.toolName\)[\s\S]*details\?\.pluginView/)
  assert.match(index, /name: 'background_start'[\s\S]*cwd, command: args\.command[\s\S]*previewUrl: args\.preview_url/)
  assert.match(index, /const preview = task\.endpoints\[0\] \? browserPreviewRequest\(task\.endpoints\[0\]\)[\s\S]*result\(task, preview \? \{ pluginView: preview \}/)
  assert.match(index, /const webResearch = new WebResearchPolicy\(\)/)
  assert.match(index, /outcomePolicy: combineOutcomePolicies\(webResearch, supervisor\)/)
  assert.match(runtime, /options\.outcomePolicy\?\.interrupt\?\.\(\)/)
  assert.match(index, /name: 'web_search'[\s\S]*site: Type\.Optional[\s\S]*exact_phrases: Type\.Optional/)
  assert.match(index, /searchWeb\(args\.query, args\.max_results, \{ site: args\.site, exactPhrases: args\.exact_phrases, renderPage: renderWebPage, fetchResource: fetchWebResource, userBrowser: userBrowserSearch \}\)/)
  // The fallback channel exists only when the user turned it on, and it is built from the Browser
  // Use service their tabs already go through rather than from a second browser of our own.
  assert.match(index, /req\.settings\.browserSearchFallback !== false && configuredPluginIds\.has\('browser-use'\)\s*\n?\s*\? createUserBrowserSearch\(/)
  assert.match(index, /closeTab: async id => \{ await chromeBrowser\.release\(sessionId, id, true\) \}/)
  assert.doesNotMatch(index, /toolNeedsApproval|agent:approve|type: 'approval'/)
  assert.doesNotMatch(index, /commandIsDestructive|commandUsesNetworkClient|localNetworkCommandAllowed/)
})

test('the supervisor observes a run instead of running one', async () => {
  const [index, runtime, supervisor] = await Promise.all([
    readFile(join(root, 'index.ts'), 'utf8'),
    readFile(join(root, 'agent-runtime.ts'), 'utf8'),
    readFile(join(root, 'agent-supervisor.ts'), 'utf8'),
  ])

  // It is a policy over the existing run: no session of its own, no second loop, no
  // model call, no tool call. Nothing here may grow into an agent.
  assert.doesNotMatch(supervisor, /createAgentSession|runAgentSession|runUtilityPrompt|defineTool|streamSimple|modelRuntime/)
  assert.doesNotMatch(supervisor, /spawn_agent|delegate_task|worker_agent|subagent/i)
  // Capability decisions stay with explicit product configuration: the supervisor
  // may send the model guidance, never change what the model can call.
  assert.doesNotMatch(supervisor, /setActiveToolsByName|getActiveToolNames|beforeToolCall/)
  // Degeneration is judged from a bounded window: the run's whole stream is never kept.
  assert.match(supervisor, /this\.tokens\.splice\(0, this\.tokens\.length - this\.limits\.windowTokens\)/)
  assert.doesNotMatch(supervisor, /private (?:readonly )?(?:messages|conversation|history):/)
  assert.doesNotMatch(supervisor, /AgentMessage\[\]/)
  // The runtime delivers an interruption while the model is still generating, and the
  // supervisor's escalation beyond steering is recorded rather than taken.
  assert.match(runtime, /const interruption = options\.outcomePolicy\?\.interrupt\?\.\(\)/)
  assert.match(runtime, /session\.steer\(interruption\)/)
  assert.match(supervisor, /maxChallenges: 1/)
  assert.match(supervisor, /maxSteers: 3/)
  // Telemetry is the point of the first implementation, and it is not user-visible chrome.
  assert.match(index, /recordSupervisorTelemetry\(req\.taskId \|\| req\.id, telemetry\)/)
  assert.match(index, /supervisor-telemetry\.jsonl/)
  assert.match(supervisor, /export function noteworthySupervisorRecord/)
})

test('hidden research Chromium remains invisible and muted before navigation', async () => {
  // The renderer lives in its own module so that the benchmark measures the same
  // channel the product uses. The invariants travel with it, and the host must
  // still be the one wiring it in, so the two cannot drift apart.
  const [index, renderPage] = await Promise.all([
    readFile(join(root, 'index.ts'), 'utf8'),
    readFile(join(root, 'web-render.ts'), 'utf8'),
  ])
  assert.match(index, /import \{ renderWebPage \} from '\.\/web-render'/)

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
  assert.match(extension, /message\?\.type === 'connect'[\s\S]*connect\(message\.force === true\)/)
  // A socket Chrome still reports as open is only trusted while Shun answers it,
  // and a worker that opens answered silence repairs itself instead of waiting
  // for the user to disable and enable the extension.
  assert.match(extension, /HEARTBEAT_BUSY_MS[\s\S]*ANSWER_BUSY_MS[\s\S]*socketAlive[\s\S]*missedAnswer/)
  // A suspended worker is woken by a tab event, so Shun opens an address the
  // extension recognises, closes, and reconnects from.
  assert.match(extension, /WAKE_URL[\s\S]*tabsRemove\(tabId\)[\s\S]*connect\(true\)/)
  assert.match(service, /wakeUrl\(\)[\s\S]*shun-wake/)
  assert.match(index, /async function wakeChromeBrowserUse[\s\S]*open', \['-g', '-a', 'Google Chrome', url\]/)
  assert.match(extension, /missedAnswer[\s\S]*if \(!bridgeAnswers\) return/)
  assert.match(extension, /retryDelay \? Math\.min\(RETRY_MAX_MS, retryDelay \* 2\) : RETRY_MIN_MS/)
  assert.match(extension, /openedIntoSilence[\s\S]*chrome\.runtime\.reload\(\)/)
  assert.match(extension, /dropSocket[\s\S]*forgetSocket/)
  assert.match(extension, /hello\.ack[\s\S]*bridgeAnswers = request\.heartbeat === true/)
  assert.match(popup, /type: 'connect', force: true/)
  assert.match(popup, /permission-probe/)
  assert.match(popup, /Approve Chrome’s local network request/)
  assert.match(popupPage, /id="connect"[\s\S]*Connect to Shun/)
  assert.match(service, /permission-probe[\s\S]*socket\.close\(1000/)
  assert.match(service, /type === 'heartbeat'[\s\S]*heartbeat\.ack/)
  assert.match(service, /type: 'hello\.ack', heartbeat: true/)
  assert.match(index, /process\.resourcesPath, 'browser-use-extension'/)
  assert.match(index, /app\.getPath\('userData'\), 'browser-use-extension'/)
  assert.match(index, /chromeBrowser\.start[\s\S]*syncBundledChromeExtension/)
  assert.match(index, /installedVersion[\s\S]*bundledManifest\.version[\s\S]*cp\(bundledExtensionDir, extensionDir/)
  assert.match(index, /mkdir\(extensionDir, \{ recursive: true \}\)[\s\S]*cp\(bundledExtensionDir, extensionDir, \{ recursive: true, force: true \}\)/)
  assert.doesNotMatch(index, /rm\(extensionDir, \{ recursive: true/)
  // The Chrome Web Store path is one flag away, and the flag cannot outrun the
  // URL it opens: the listing URL is derived from the allowlisted store ID.
  assert.match(service, /export const SHUN_CHROME_EXTENSION_STORE_LIVE = (true|false)/)
  assert.match(service, /SHUN_CHROME_EXTENSION_STORE_URL = `https:\/\/chromewebstore\.google\.com\/detail\/\$\{SHUN_CHROME_STORE_EXTENSION_ID\}`/)
  assert.match(index, /SHUN_CHROME_EXTENSION_STORE_LIVE[\s\S]*openExternal\(SHUN_CHROME_EXTENSION_STORE_URL\)/)
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

test('Windows shell support stays a platform-gated product boundary', async () => {
  const [shellTool, shellEnvironment, windows] = await Promise.all([
    readFile(join(root, 'shell-tool.ts'), 'utf8'),
    readFile(join(root, 'shell-environment.ts'), 'utf8'),
    readFile(join(root, 'windows-shell.ts'), 'utf8'),
  ])
  // Other platforms keep pi's own shell backend, description, and PATH handling.
  assert.match(shellTool, /const windows = process\.platform === 'win32' \? resolveWindowsShell\(process\.env\) : undefined/)
  assert.match(shellTool, /operations: windows/)
  // pi's exit status stays authoritative: the product does not rewrite the command
  // line with a prefix that would make bounded exploration report failure. The
  // resulting behavior is pinned by the shell tool's own execution test.
  assert.doesNotMatch(shellTool, /commandPrefix/)
  assert.match(shellEnvironment, /if \(platform === 'win32'\) return refreshWindowsPath\(env, \{ run \}\)/)
  // Windows never requires bash, and PATH is re-read from the machine.
  assert.doesNotMatch(windows, /getShellConfig|No bash shell found/)
  assert.match(windows, /WindowsPowerShell[\s\S]*kind: 'powershell'/)
  assert.match(windows, /OutputEncoding=\[System\.Text\.Encoding\]::UTF8/)
  assert.match(windows, /reg', \['query', key, '\/v', 'Path'\]/)
  assert.doesNotMatch(windows, /req\.text|process\.argv/)
})

test('Windows keeps a hidden session reachable from the tray', async () => {
  const [index, tray] = await Promise.all([
    readFile(join(root, 'index.ts'), 'utf8'),
    readFile(join(root, 'windows-tray.ts'), 'utf8'),
  ])
  // Closing the window preserves the running session; the tray offers the menu contents.
  assert.match(index, /window\.on\('close', event => \{[\s\S]*?if \(!trayHost\.hidesOnClose\(quitting\)\) return[\s\S]*?event\.preventDefault\(\)[\s\S]*?window\.hide\(\)[\s\S]*?trayHost\.notifyBackground\(\)/)
  assert.match(index, /const trayHost = createTrayHost\(\{/)
  assert.match(index, /openSettings: \(\) => win\?\.webContents\.send\('ui:settings'\)/)
  assert.match(index, /onDoubleClick: listener => \{ tray\.on\('double-click', listener\) \}/)
  assert.match(index, /app\.on\('before-quit', \(\) => \{ quitting = true;/)
  assert.match(index, /trayIconPath\(app\.getAppPath\(\)\)/)
  assert.match(index, /trayHost\.install\(trayLanguageFromState\(\(await storedStates\(\)\)\[0\]\)\)/)
  assert.match(index, /trayHost\.refresh\(trayLanguageFromState\(state\)\)/)
  // Model and host stay Electron-free so every platform can exercise them.
  assert.match(tray, /export type TrayCommand = 'show' \| 'settings' \| 'quit'/)
  assert.match(tray, /export function createTrayHost\(options: TrayOptions\)/)
  assert.match(tray, /if \(options\.platform !== 'win32'\) return false/)
  assert.match(tray, /platform === 'win32' && trayReady && !quitting/)
  assert.doesNotMatch(tray, /from 'electron'/)
  assert.doesNotMatch(tray, /BrowserWindow|\bspawn\b|process\.argv/)
  const icon = await readFile(join(root, '../../resources/tray-icon.png'))
  assert.equal(icon.subarray(1, 4).toString('ascii'), 'PNG')
})

test('project names come from the shared workspace label instead of a POSIX-only split', async () => {
  const [app, shared] = await Promise.all([
    readFile(join(root, '../renderer/src/app.tsx'), 'utf8'),
    readFile(join(root, '../shared.ts'), 'utf8'),
  ])
  assert.doesNotMatch(app, /\.workspace\.split\(['"]\/['"]\)/)
  assert.match(app, /workspace = workspaceLabel\(task\?\.workspace, zh \? "选择项目" : "Choose project"\)/)
  assert.match(app, /<span>\{workspaceLabel\(path\)\}<\/span>/)
  assert.match(shared, /export function workspaceLabel\(value: string \| undefined \| null, fallback = ''\)/)
})

test('updates measure their release source instead of assuming github.com', async () => {
  const [updater, probe, sources, manifest] = await Promise.all([
    readFile(join(root, 'app-updater.ts'), 'utf8'),
    readFile(join(root, 'release-probe.ts'), 'utf8'),
    readFile(join(root, 'release-sources.ts'), 'utf8'),
    readFile(join(root, '../../package.json'), 'utf8'),
  ])
  const publish = JSON.parse(manifest).build.publish.find((entry: { provider: string }) => entry.provider === 'github')
  // The feed follows the measured source, and long-lived selection is bounded by a TTL.
  assert.match(updater, /await selectReleaseSource\(\{/)
  assert.match(updater, /setFeedURL\(\{ provider: 'generic', url: selection\.source\.base \}\)/)
  assert.match(updater, /const SOURCE_TTL_MS = 30 \* 60 \* 1000/)
  assert.match(updater, /measureThroughput: mode === 'download'/, 'a periodic check must not spend bandwidth')
  assert.match(updater, new RegExp(`UPDATE_OWNER = '${publish.owner}'`))
  assert.match(updater, new RegExp(`UPDATE_REPO = '${publish.repo}'`))
  assert.match(updater, /disableDifferentialDownload = selection\.source\.kind === 'mirror'/, 'third-party hops get whole-file verification')
  // Mirrored packages are checked against published digests before installing.
  assert.match(updater, /digestForFile\(parseChecksums\(body\), name\)/)
  assert.match(updater, /did not match the published checksum, so it will not be installed/)
  assert.match(updater, /autoUpdater\.autoInstallOnAppQuit = false/)
  assert.match(updater, /this\.failedSources\.add\(failed\.id\)/)
  // Probes are bounded, follow the system proxy, and the model stays Electron-free.
  assert.match(probe, /AbortSignal\.timeout\(timeoutMs\)/)
  assert.match(probe, /net\.fetch\(url, \{/)
  assert.doesNotMatch(sources, /from 'electron'/)
  assert.doesNotMatch(sources, /process\.argv|req\.text/)
  assert.match(sources, /releases\/latest\/download/)
  assert.match(sources, /releases\/download\/v\$\{version\}/)
})

test('a plugin view keeps the renderer\'s workspace string and reads its task directory', async () => {
  const index = await readFile(join(root, 'index.ts'), 'utf8')

  // The panel only renders while `boundWorkspace === task.workspace`, so the
  // value handed back must stay what the renderer passed. Resolving an empty
  // workspace here (or to the task directory) hides the panel instead of
  // binding it — the failure looks like the view button doing nothing.
  assert.match(index, /function pluginBoundWorkspace\(workspace: string\): string \{/)
  assert.match(index, /plugins:view-open'[\s\S]{0,400}?pluginBoundWorkspace\(workspace\)/)
  assert.doesNotMatch(index, /plugins:view-open'[\s\S]{0,400}?pluginTaskRoot\(/)

  // A standalone task still has a real directory. Authorization has to use the
  // string the grant recorded, while the files come from the task's own
  // directory; one variable for both is what broke every call.
  assert.match(index, /const authWorkspace = pluginBoundWorkspace\(workspace\)/)
  assert.match(index, /const root = authWorkspace \|\| pluginTaskRoot\('', taskId\)/)
  assert.doesNotMatch(index, /, root, taskId\)/, 'authorization must use the bound workspace, not the resolved root')

  // The agent's half of the bridge: same state key as the view, and an event
  // carrying the string the renderer filters on.
  assert.match(index, /plugin_workspace_state'[\s\S]{0,2200}?const workspace = pluginTaskRoot\(req\.settings\.workspace \|\| '', req\.taskId \|\| req\.id\)/)
  assert.match(index, /const authWorkspace = pluginBoundWorkspace\(req\.settings\.workspace \|\| ''\)/)
  assert.match(index, /emitPluginWorkspaceState\(args\.plugin_id, authWorkspace, args\.key, value\)/)
})
