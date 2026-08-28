import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Marked } from 'marked'
import { buildExcalidrawFlowSkeleton, stableExcalidrawSeed } from '../renderer/src/mermaid/excalidraw-flow-model.ts'
import { accentColor, accentOptions } from '../renderer/src/accent.ts'
import { markedMathExtension } from '../renderer/src/math-markdown.ts'
import { completedMermaidBlockCount, feedScrollModeAfterScroll, finishTaskRun, nextRunnablePrompt, nextStreamingText, runningTurnAnchorId, settleTurnCompaction, streamedFeedScrollTop, summarizedFailureCount, taskHasActiveBackground, taskRunIsActive, toolChangesSkillCatalog, turnAwaitsModelOutput, visibleWorkspaceChangeCount } from '../renderer/src/task-runtime.ts'

test('streamed text reveals small chunks character by character and catches up on large chunks', () => {
  assert.equal(nextStreamingText('', '你好'), '你')
  assert.equal(nextStreamingText('你', '你好'), '你好')
  assert.equal(nextStreamingText('', 'abcdefghijklmnopqrstuvwxyz'), 'ab')
  const largeStep = nextStreamingText('', 'x'.repeat(1_000))
  assert.ok(largeStep.length > 4 && largeStep.length < 1_000)
  assert.equal(nextStreamingText('old', 'replacement'), 'replacement')
  assert.equal(nextStreamingText('done', 'done'), 'done')
})

test('remote commands wait for the renderer handler during Desktop startup', async () => {
  const [preload, main] = await Promise.all([
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
  ])

  assert.match(preload, /const queuedRemoteRequests = new Map<string, RemoteBridgeRequest>\(\)/)
  assert.match(preload, /if \(!handler\) \{[\s\S]*queuedRemoteRequests\.set\(request\.id, request\)[\s\S]*return/)
  assert.match(preload, /remoteRequestHandler = fn[\s\S]*void drainRemoteRequests\(\)/)
  assert.doesNotMatch(preload, /Shun Desktop is still loading/)
  assert.match(main, /frame\.kind === 'task\.context\.compact' \? 120_000 : 45_000/)
  assert.ok(main.indexOf('createWindow(await storedWindowTheme())') < main.indexOf('await remoteRelay.start()'))
})

test('high-frequency run events stay bounded and streaming markdown is always rendered', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const onEvent = app.slice(app.indexOf('function onEvent'), app.indexOf('function onBackgroundEvent'))
  const message = app.slice(app.indexOf('const Message = memo'), app.indexOf('async function renderMermaid'))

  assert.match(onEvent, /frame\.current = window\.setTimeout\([\s\S]*applyPending\(xs, pending\)[\s\S]*}, 50\)/)
  assert.match(onEvent, /event\.type === "reasoning"[\s\S]*now - previous < 1000/)
  assert.match(onEvent, /event\.tool\?\.state === "running"[\s\S]*if \(!visibleRunningTools\.current\.has\(key\)\)[\s\S]*visibleRunningTools\.current\.add\(key\)[\s\S]*else \{[\s\S]*pendingToolUpdates[\s\S]*}, 100\)/)
  assert.match(message, /const Message = memo\(function Message/)
  assert.match(message, /minimumInterval = target\.length > 48_000 \? 100 : target\.length > 12_000 \? 50 : 32/)
  assert.match(message, /renderMarkdownFragment\(renderedText\)/)
  assert.match(message, /dangerouslySetInnerHTML=\{\{ __html: renderedHtml \}\}/)
  assert.doesNotMatch(message, /stream-markdown-tail|stableMarkdownBoundary/)
  assert.match(app, /streaming=\{turn\.id === running && i === entries\.length - 1\}/)
})

test('thinking uses a decoded image shimmer while elapsed time updates in an isolated turn header', async () => {
  const [app, css, composerCss, main, darkShimmer, lightShimmer, darkThinking, lightThinking] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/composer-state.css', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/assets/status-shimmer-dark.webp', import.meta.url)),
    readFile(new URL('../renderer/src/assets/status-shimmer-light.webp', import.meta.url)),
    readFile(new URL('../renderer/src/assets/thinking-shimmer-dark.webp', import.meta.url)),
    readFile(new URL('../renderer/src/assets/thinking-shimmer-light.webp', import.meta.url)),
  ])

  assert.match(app, /return <span class="swipe-layers">\{text\}<\/span>/)
  assert.equal(app.match(/<SwipeLayers /g)?.length, 4)
  assert.match(app, /<b class="thinking-label text-swipe">\s*<SwipeLayers text=\{label\} \/>\s*<\/b>/)
  assert.match(app, /executing \? <SwipeLayers text=\{copy\.title\} \/> : copy\.title/)
  assert.match(app, /executing \? <SwipeLayers text="Working" \/> : sentence/)
  assert.match(app, /tool\.state === "running" \? <SwipeLayers text=\{detail\.title\} \/> : detail\.title/)
  assert.match(css, /\.thinking\{[^}]*display:flex;align-items:baseline;[^}]*padding:4px 0;[^}]*line-height:20px/)
  assert.match(css, /\.thinking \.thinking-label\{[^}]*font-size:12\.5px;[^}]*font-weight:480/)
  assert.doesNotMatch(css, /\.thinking\{[^}]*padding-left:/)
  assert.doesNotMatch(composerCss, /\.thinking>span\{/)
  assert.match(css, /\.swipe-layers\{[^}]*background-image:url\('\.\/assets\/status-shimmer-dark\.webp'\);[^}]*background-clip:text;[^}]*-webkit-text-fill-color:transparent/)
  assert.match(css, /:root\[data-theme="light"\] \.swipe-layers\{background-image:url\('\.\/assets\/status-shimmer-light\.webp'\)\}/)
  assert.match(css, /\.text-swipe \.swipe-layers\{background-image:url\('\.\/assets\/thinking-shimmer-dark\.webp'\)\}/)
  assert.match(css, /:root\[data-theme="light"\] \.text-swipe \.swipe-layers\{background-image:url\('\.\/assets\/thinking-shimmer-light\.webp'\)\}/)
  assert.ok(darkShimmer.length < 10_000 && lightShimmer.length < 10_000)
  assert.ok(darkThinking.length < darkShimmer.length && lightThinking.length < lightShimmer.length)
  assert.equal(darkShimmer.subarray(0, 4).toString(), 'RIFF')
  assert.equal(lightShimmer.subarray(0, 4).toString(), 'RIFF')
  const swipeCss = css.slice(css.indexOf('/* Running-state shimmer'), css.indexOf('.turn-runtime'))
  assert.doesNotMatch(swipeCss, /background-position:|animation:|will-change:|clip-path:|mask-image:/)
  assert.doesNotMatch(app, /shimmerFrames|requestAnimationFrame\(runShimmerFrames\)|canvasRef/)
  assert.doesNotMatch(css, /\.text-swipe\{[^}]*color:transparent/)
  assert.doesNotMatch(css, /\.(?:sidebar|stage)\{[^}]*backdrop-filter:/)
  assert.doesNotMatch(css, /:root \.sidebar[^}]*backdrop-filter:/)
  assert.doesNotMatch(css, /\.feed article,\.feed \.tool,\.feed \.tool pre\{animation:none/)
  assert.match(main.slice(main.indexOf('function createWindow'), main.indexOf('async function inspectLocalPage')), /vibrancy:\s*'under-window'[\s\S]*visualEffectState:\s*'active'/)
  const motion = await readFile(new URL('../renderer/src/motion.css', import.meta.url), 'utf8')
  assert.match(motion, /article\{animation:message \.28s var\(--ease\)\}/)
  assert.match(motion, /\.tool\{animation:tool-in \.24s var\(--ease\);/)
  assert.match(motion, /\.tool pre\{animation:reveal \.2s var\(--ease\)\}/)
  assert.doesNotMatch(motion, /(?:article|\.tool|\.tool pre)\{animation:[^}]* both/)
  const thinkingIndicator = app.slice(app.indexOf('function ThinkingIndicator'), app.indexOf('const fullscreenIcon'))
  assert.match(app, /<TurnRuntime turn=\{turn\} running=\{running\} language=\{language\} \/>/)
  assert.doesNotMatch(app, /class="turn-runtime active"/)
  assert.match(app, /class="turn-runtime completed">\s*<span>[\s\S]*<time>/)
  assert.match(css, /\.turn-runtime\{[^}]*margin:8px 0 0;[^}]*padding:0;[^}]*display:flex;[^}]*justify-content:flex-start/)
  assert.doesNotMatch(css, /\.turn-runtime\{[^}]*border/)
  assert.match(thinkingIndicator, /<ThinkingElapsed key=\{turn\.phase\} \/>/)
  assert.match(thinkingIndicator, /const ThinkingLabel = memo/)
  assert.match(thinkingIndicator, /runningTool = turnTools\(turn\)\.some\(\(tool\) => tool\.state === "running"\)/)
  assert.match(thinkingIndicator, /\[quietAfterText, setQuietAfterText\] = useState\(false\)/)
  assert.match(thinkingIndicator, /window\.setTimeout\(\(\) => setQuietAfterText\(true\), 300\)/)
  assert.match(thinkingIndicator, /\[awaitingOutput, runningTool, runningTurn, turn\.content\]/)
  assert.match(thinkingIndicator, /runningTurn && !runningTool && \(awaitingOutput \|\| quietAfterText\)/)
  assert.match(app, /const ThinkingElapsed = memo[\s\S]*startedAt = useRef\(Date\.now\(\)\)[\s\S]*hidden = elapsed < 1000[\s\S]*textContent = elapsed < 1000 \? "" : formatElapsed\(elapsed\)[\s\S]*window\.setTimeout\(update/)
  assert.match(app, /return <time ref=\{elapsedRef\} class="thinking-elapsed" hidden \/>/)
  const history = app.slice(app.indexOf('function TaskHistory'), app.indexOf('function TurnRuntime'))
  assert.ok(history.indexOf('<TurnContent ') < history.indexOf('<ThinkingIndicator '))
  assert.ok(history.indexOf('<ThinkingIndicator ') < history.indexOf('<TurnRuntime '))
  assert.match(css, /\.thinking-elapsed\{[^}]*font-variant-numeric:tabular-nums/)
  assert.doesNotMatch(thinkingIndicator, /useElapsedClock/)
  assert.doesNotMatch(app, /\[clock, setClock\] = useState/)
})

test('conversation chrome follows the interface language and message editing stays in one compact surface', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])
  const history = app.slice(app.indexOf('function TaskHistory'), app.indexOf('function TurnRuntime'))

  assert.doesNotMatch(app, /function taskLanguage/)
  assert.match(app, /<TaskHistory[\s\S]*language=\{uiLanguage\}/)
  assert.match(app, /<GoalControl[\s\S]*language=\{uiLanguage\}/)
  assert.match(app, /<span>\{uiLanguage === 'zh' \? '已排队' : 'Queued'\}<\/span>/)
  assert.match(history, /language: UiLanguage/)
  assert.match(history, /class=\{`body\$\{editing\?\.id === turn\.id \? " editing" : ""\}`\}/)
  assert.match(css, /\.user \.body\.editing\{[^}]*width:min\(620px,88%\);[^}]*max-width:min\(620px,88%\)/)
  assert.match(css, /\.turn-editor\{width:100%;min-width:0;/)
  assert.match(css, /\.turn-editor textarea\{[^}]*width:100%;[^}]*border:0;[^}]*background:transparent/)
  assert.doesNotMatch(css, /\.turn-editor\{width:min\(620px,calc\(100vw/)
})

test('a settled tool restores model activity until the next text delta starts', () => {
  const base = {
    id: 'run-1', role: 'assistant' as const, content: 'I will inspect the design.', phase: 'Thinking',
  }
  assert.equal(turnAwaitsModelOutput(base), false)
  assert.equal(turnAwaitsModelOutput({
    ...base,
    timeline: [
      { type: 'text', text: 'I will inspect the design.' },
      { type: 'tool', tool: { id: 'read-1', name: 'figma_read_design', input: '{}', state: 'done' } },
    ],
  }), true)
  assert.equal(turnAwaitsModelOutput({
    ...base,
    timeline: [
      { type: 'text', text: 'I will inspect the design.' },
      { type: 'tool', tool: { id: 'read-1', name: 'figma_read_design', input: '{}', state: 'running' } },
    ],
  }), false)
  assert.equal(turnAwaitsModelOutput({
    ...base,
    content: 'I will inspect the design. The result is clear.',
    timeline: [
      { type: 'text', text: 'I will inspect the design.' },
      { type: 'tool', tool: { id: 'read-1', name: 'figma_read_design', input: '{}', state: 'done' } },
      { type: 'text', text: 'The result is clear.' },
    ],
  }), false)
})

test('context compaction is mutually exclusive with model activity', async () => {
  const compacting = {
    id: 'run-1', role: 'assistant' as const, content: '', phase: 'Thinking',
    contextUsage: { state: 'compacting' as const, usedCharacters: 0, budgetCharacters: 100_000 },
    timeline: [{ type: 'context' as const, context: { state: 'compacting' as const, usedCharacters: 0, budgetCharacters: 100_000 } }],
  }
  assert.equal(turnAwaitsModelOutput(compacting), false)
  const settled = settleTurnCompaction(compacting)
  assert.equal(settled.contextUsage?.state, 'compacted')
  assert.equal(settled.timeline?.[0].type === 'context' && settled.timeline[0].context.state, 'compacted')

  const [runtime, app] = await Promise.all([
    readFile(new URL('./agent-runtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
  ])
  const end = runtime.slice(runtime.indexOf("event.type === 'compaction_end'"), runtime.indexOf('\n  }\n}', runtime.indexOf("event.type === 'compaction_end'")))
  assert.ok(end.indexOf("state: 'compacted'") < end.indexOf("type: 'compacted'"))
  assert.match(app, /zh \? "系统提示词" : "System prompt"/)
  assert.match(app, /zh \? "MCP 桥接" : "MCP bridge"/)
  assert.match(app, /tokens == null \? "—" : compactCount\(tokens\)/)
  assert.doesNotMatch(app, /breakdownRows\.length > 0/)
})

test('sidebar footer keeps compact settings and mobile icons while restoring the full update action', async () => {
  const [app, css, updateCss] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app-update.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /class=\{`sidebar-version\$\{import\.meta\.env\.DEV \? " development" : ""\}`\}/)
  assert.match(app, /displayedVersion = appUpdate\?\.currentVersion \|\| __SHUN_VERSION__/)
  assert.match(app, /v\{displayedVersion\}/)
  assert.match(css, /\.sidebar-version\.development\{color:#58b87a\}/)
  assert.match(app, /class="sidebar-footer-left"/)
  assert.match(app, /sidebar-footer-icon sidebar-pair-mobile/)
  assert.match(app, /class=\{`sidebar-update \$\{appUpdate\.status\}`\}/)
  assert.match(app, /<Download \/>/)
  assert.match(app, /zh \? "更新" : "Update"/)
  assert.match(app, /appUpdate\.targetVersion \? ` v\$\{appUpdate\.targetVersion\}`/)
  assert.doesNotMatch(app, /sidebar-version-action/)
  assert.match(css, /\.sidebar \.sidebar-footer\{[^}]*display:flex!important;[^}]*align-items:center;[^}]*justify-content:space-between/)
  assert.match(css, /\.sidebar-footer-left\{[^}]*display:flex;[^}]*align-items:center;[^}]*gap:0/)
  assert.match(css, /\.sidebar-footer-left \.sidebar-footer-icon\{[^}]*width:27px/)
  assert.doesNotMatch(css, /sidebar-footer:has\(\.sidebar-update\)/)
  assert.match(updateCss, /\.sidebar-update\{[^}]*border:1px solid[^}]*background:color-mix/)
  assert.match(css, /\.sidebar-settings svg\{[^}]*flex:0 0 15px/)
})

test('project tasks share the project-name text baseline while standalone tasks stay top-level', async () => {
  const css = await readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')

  assert.match(css, /\.workspace-head\{padding-left:10px\}/)
  assert.match(css, /\.workspace-head>svg\{[^}]*width:17px;[^}]*flex:0 0 17px/)
  assert.match(css, /\.workspace-tasks \.task\{[^}]*margin-inline:0;[^}]*padding:0 9px 0 35px/)
  assert.match(css, /\.workspace-group\.loose \.workspace-tasks \.task\{padding-left:9px\}/)
})

test('sidebar task groups reveal bounded pages without hiding a selected older task', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/task-tree.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /function sidebarTaskPageSize\(workspace: string\) \{ return workspace \? 10 : 50; \}/)
  assert.match(app, /groupTasks = group\.tasks\.slice\(0, groupLimit\)/)
  assert.match(app, /\(current\[limitKey\] \|\| pageSize\) \+ pageSize/)
  assert.match(app, /revealSidebarTask\(next\)/)
  assert.match(app, /Math\.ceil\(\(index \+ 1\) \/ pageSize\) \* pageSize/)
  assert.match(css, /\.workspace-more\{width:100%;height:29px;/)
})

test('the composer project context stays compact above the input surface', async () => {
  const [app, composer, project, interaction] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/composer.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/project-picker.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/interaction-fix.css', import.meta.url), 'utf8'),
  ])
  const dock = app.slice(app.indexOf('<div class="dock">'), app.indexOf('{!!queued.filter', app.indexOf('<div class="dock">')))
  assert.match(composer, /\.context-strip \{[^}]*height: 32px;/)
  assert.match(composer, /\.context-strip \{[^}]*border-radius: 11px 11px 0 0;/)
  assert.match(composer, /\.context-strip \{[^}]*background: linear-gradient\(180deg, #1c1c1cf2 0%, #202020f2 100%\);/)
  assert.match(project, /\.context-workspace\{height:24px;/)
  assert.match(interaction, /\.context-strip\{[^}]*height:34px[^}]*margin:0 0 -5px 14px[^}]*padding:3px 4px 6px[^}]*border-radius:10px 10px 0 0/)
  assert.match(interaction, /\.context-strip\{[^}]*background:linear-gradient\(180deg,#212121 0%,#232323 100%\)/)
  assert.doesNotMatch(interaction, /\.context-strip\{[^}]*height:42px/)
  assert.doesNotMatch(dock, /changeCount|Review workspace changes/)
  assert.match(app, /class="repository-branch"[\s\S]*repository\.files\.length > 0[\s\S]*<em>\{repository\.files\.length\}<\/em>/)
})

test('settings group appearance choices without nested cards and keep the provider list unframed', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /class="appearance-choice-list"/)
  assert.equal(app.match(/class="appearance-choice-row"/g)?.length, 3)
  assert.match(css, /\.settings-modal \.appearance-choice-row \.segmented button:hover\{background:color-mix\(/)
  assert.match(css, /\.settings-modal \.provider-list,:root\[data-theme="light"\] \.settings-modal \.provider-list\{[^}]*background:transparent/)
})

test('appearance offers a broad, soft accent palette backed by one color source', () => {
  assert.ok(accentOptions.length > 7)
  assert.equal(new Set(accentOptions).size, accentOptions.length)
  for (const accent of accentOptions) assert.match(accentColor(accent), /^#[0-9a-f]{6}$/i)
  assert.equal(accentColor('unknown'), accentColor('blue'))
})

test('settings share one surface, hover, and selection hierarchy', async () => {
  const css = await readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')

  assert.match(css, /--settings-surface:/)
  assert.match(css, /--settings-hover:/)
  assert.match(css, /--settings-selected:/)
  assert.match(css, /\.settings-modal \.settings-layout>nav button\.active[^}]*background:var\(--settings-surface\)/)
  assert.match(css, /\.settings-modal \.provider-list>button\.active[^}]*background:var\(--settings-surface\)/)
  assert.match(css, /\.settings-modal \.provider-editor[^}]*background:var\(--settings-surface\)/)
})

test('diff hover fixes stay scoped and do not recolor the sidebar', async () => {
  const css = await readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')

  assert.match(css, /--hover-bg:#252525/)
  assert.match(css, /--sidebar-item-hover:#242424/)
  assert.match(css, /--sidebar-item-selected:#2b2b2b/)
  assert.match(css, /\.diff-files\{border-color:var\(--border-1\);background:var\(--sidebar-bg\)/)
  assert.match(css, /\.diff-files button:hover\{background:var\(--sidebar-hover-bg\)/)
  assert.match(css, /\.diff-files button\.active\{background:var\(--sidebar-item-selected\)/)
})

test('settings share quiet module styling without rewriting component layouts', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])

  assert.equal(app.match(/class="appearance-choice-row"/g)?.length, 3)
  assert.doesNotMatch(app, /class="appearance-group"/)
  assert.match(css, /Settings modules share one quiet surface treatment without changing their layout/)
  assert.match(css, /\.settings-modal \.choice\{[^}]*grid-template-columns:1fr 1fr;[^}]*gap:7px/)
  assert.match(css, /\.settings-modal \.provider-model-row\{border:0;border-radius:10px;background:var\(--settings-field\)\}/)
})

test('task and settings sidebars share panel and item interaction tokens', async () => {
  const css = await readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')

  assert.match(css, /--sidebar-item-height:36px/)
  assert.match(css, /--sidebar-item-radius:8px/)
  assert.match(css, /:root \.sidebar,:root \.settings-modal \.settings-layout>nav\{[^}]*background:var\(--sidebar-glass\)/)
  assert.match(css, /\.sidebar \.workspace-tasks \.task:not\(\.active\):hover,[\s\S]*\.settings-modal \.settings-layout>nav button:not\(\.active\):hover\{[\s\S]*background:var\(--sidebar-item-hover\)/)
  assert.match(css, /\.sidebar \.workspace-tasks \.task\.active,[\s\S]*\.settings-modal \.settings-layout>nav button\.active,[\s\S]*background:var\(--sidebar-item-selected\)/)
})

test('delete confirmation dismisses task menus and keeps its destructive action red', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])
  const deleteTask = app.slice(app.indexOf('function deleteTask'), app.indexOf('function beginRename'))

  assert.match(deleteTask, /setItemMenu\(""\)/)
  assert.match(deleteTask, /setTaskMenuPosition\(null\)/)
  assert.match(deleteTask, /commitTasks[\s\S]*window\.shun\.deleteTaskData\(id\)/)
  assert.doesNotMatch(deleteTask, /removeTaskAttachments/)
  assert.match(css, /\.confirm-veil\{z-index:100\}/)
  assert.match(css, /:root\[data-theme="light"\] \.confirm-dialog button\.danger\{[^}]*background:#b94f59;[^}]*color:#fff/)
  assert.match(css, /:root\[data-theme="light"\] \.confirm-dialog button\.danger:hover\{[^}]*background:#a8424c;[^}]*color:#fff/)
})

test('provider settings do not claim connectivity without a real probe', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])
  const start = app.indexOf('{tab === "providers" && <section>')
  const end = app.indexOf('{tab === "model"', start)
  const panel = app.slice(start, end)

  assert.doesNotMatch(panel, /Connected ·|Not connected|已连接 ·|未连接/)
  assert.doesNotMatch(app, /选择厂商即可|Shun fills in endpoints/)
  assert.doesNotMatch(app, /现有 Provider 不会被修改|existing Providers? (?:will not|won't) be modified/i)
  assert.doesNotMatch(app, /模型已自动配置|无需填写|Models configured automatically|No setup required/)
  assert.match(app, /More providers/)
  assert.match(app, /simpleCloudProviders[\s\S]*slice\(0, 8\)/)
  assert.match(app, /mainstreamProviderIds\.map/)
  assert.doesNotMatch(app, /class=\{models\.length \? "online"/)
  assert.doesNotMatch(panel, /\{models\.length\}/)
  assert.match(panel, /class="provider-editor-heading"/)
  assert.match(panel, /class="provider-models-columns"/)
  assert.match(panel, /!active \? providerSetup\(\) : <div class="provider-layout">/)
  assert.match(panel, /<div class="provider-editor">/)
  assert.match(app, /addingProvider && active && <div class="provider-dialog-veil"/)
  assert.match(app, /class="provider-dialog" role="dialog" aria-modal="true"/)
  assert.match(panel, /class=\{`test-deployment/)
  assert.match(app, /window\.shun\.testModel\(active\.endpoint, active\.apiKey, model\.id, active\.api\)/)
  assert.doesNotMatch(panel, /class=\{`test-deployment[^>]*\stitle=/)
  assert.match(panel, /t\("Testing", "测试中"\)/)
  assert.match(panel, /class="loading-spinner"/)
  assert.match(app, /Promise\.race\(\[window\.shun\.testModel/)
  assert.match(app, /catch \(error\)/)
  assert.match(css, /\.settings-modal \.test-deployment\{[^}]*width:62px;[^}]*display:flex/)
  assert.match(css, /Providers are edited as one connection followed by one flat deployment table\./)
  assert.match(css, /\.settings-modal \.provider-model-row\{[^}]*border-radius:0;[^}]*background:transparent/)
  assert.match(app, /function DeferredNumberInput/)
  assert.match(app, /onInput=\{\(event\) => setDraft\(event\.currentTarget\.value\)\}/)
  assert.match(app, /onBlur=\{\(event\) => commit\(event\.currentTarget\.value\)\}/)
  assert.doesNotMatch(panel, /onInput=\{\(event\) => editModel\(model\.id, "(?:contextWindow|maxOutputTokens)"/)
  assert.match(app, /class="deployment-select-control"[\s\S]*<ChevronDown aria-hidden="true"/)
  assert.match(css, /\.deployment-select-control select\{[^}]*appearance:none/)
  assert.match(app, /compactProviderModelMenu\(providerModels/)
  assert.match(app, /class=\{`model-more/)
  assert.match(app, /class="model-picker-history"/)
  assert.match(app, /discoverLocalModels = active && \["ollama", "lmstudio", "vllm", "llamacpp"\]/)
  assert.doesNotMatch(app, /setInterval\(probe, 15000\)/)
  assert.match(app, /Date\.now\(\) - lastProbeAt >= 10 \* 60_000/)
  assert.match(app, /const metadata = new Map\(source\.models\.map/)
  assert.match(css, /--floating-panel-bg:rgba\(25,25,25,\.96\)/)
  assert.match(css, /--composer-popover-bg:var\(--floating-panel-bg\)/)
  assert.match(css, /\.picker\.model-picker\{width:284px;max-height:276px;padding:4px/)
  assert.match(app, /zh \? "模型设置" : "Model settings"/)
  assert.match(app, /compactCloudProviderDeployments\(normalizedModels, configured\.model\)/)
  assert.match(app, /class="provider-dialog deployment-library-dialog"/)
  assert.match(app, /availableCatalogModels\.filter[\s\S]*slice\(0, 50\)/)
})

test('plugin hub exposes only implemented product capabilities', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/plugin-hub.css', import.meta.url), 'utf8'),
  ])
  const settings = app.slice(app.indexOf('function SettingsPage'), app.indexOf('function PluginHub'))

  assert.match(app, /mcpServers: Array\.isArray\(configured\.mcpServers\) \? configured\.mcpServers : \[\]/)
  assert.match(app, /plugins: Array\.isArray\(configured\.plugins\) \? configured\.plugins : \[\]/)
  assert.match(app, /skills: Array\.isArray\(configured\.skills\) \? configured\.skills : \[\]/)
  assert.match(app, /class=\{!showSchedules && showPlugins \? "active" : ""\}/)
  const sidebarNav = app.slice(app.indexOf('<div class="nav">'), app.indexOf('<div class="tasks task-tree">'))
  assert.ok(sidebarNav.indexOf('zh ? "插件" : "Plugins"') < sidebarNav.indexOf('zh ? "已归档" : "Archived"'))
  assert.match(app, /showSchedules \? \([\s\S]*<ScheduledPage[\s\S]*: showPlugins \? \(\s*<PluginHub/)
  assert.match(app, /installed-plugin-strip/)
  assert.match(app, /plugin-catalog-grid/)
  assert.match(app, /plugin-kind-tabs[\s\S]*Plugins[\s\S]*Skills/)
  assert.match(app, /window\.shun\.skills\(value\)/)
  assert.doesNotMatch(app, /Available skills|可用 Skills/)
  assert.match(app, /skill-grid/)
  assert.match(app, /installedSkills\.map/)
  assert.match(app, /Agent Skills use the open SKILL\.md format and load progressively only when relevant/)
  assert.match(app, /Local Skill/)
  assert.match(app, /Project Skill/)
  assert.match(app, /Skill package/)
  assert.match(app, /From \$\{plugin\.name\} plugin/)
  assert.match(app, /editSkill\(skill, event\.currentTarget\.checked\)/)
  assert.match(app, /window\.shun\.createSkill/)
  assert.match(app, /window\.shun\.importSkills/)
  assert.match(app, /skillDialogDirty = skillDialog === "create"/)
  assert.match(app, /requestCloseSkillDialog = \(\) =>/)
  assert.match(app, /class="plugin-dialog-backdrop skill-editor-backdrop"/)
  assert.match(app, /skillDiscardOpen && <div class="skill-discard-backdrop"/)
  assert.match(app, /Discard unsaved changes\?/)
  assert.doesNotMatch(app, /skillDialog === "create" && <div class="plugin-dialog-backdrop" onPointerDown=/)
  assert.doesNotMatch(app, /skillDialog === "detail" && skillDocument && <div class="plugin-dialog-backdrop" onPointerDown=/)
  assert.match(app, /window\.shun\.installSkillPackage/)
  assert.match(app, /window\.shun\.updateSkill/)
  assert.match(app, /window\.shun\.removeSkill/)
  assert.match(app, /aria-label=\{toggleLabel\}/)
  assert.doesNotMatch(app, /skill\.enabled \? t\("On", "已开启"\)/)
  assert.doesNotMatch(app, /Skills are focused workflows supplied by installed plugins/)
  assert.match(app, /plugin-dialog/)
  assert.match(app, /plugin-page-heading/)
  assert.match(app, /window\.shun\.plugins\(value\)/)
  assert.match(app, /window\.shun\.pluginConnection\(plugin\.id\)/)
  assert.match(app, /window\.shun\.connectPlugin\(plugin\.id/)
  assert.match(app, /Personal Access Token/)
  assert.match(app, /authorizationExpanded && selected\.id === "figma"/)
  assert.match(app, /authorizationExpanded && selected\.id === "render"/)
  assert.match(app, /authorizationExpanded && selected\.id === "cloudflare"/)
  assert.match(app, /selected\.id === "godot"[\s\S]*local Godot 4 editor CLI/)
  assert.match(app, /icon === "gmail"\) return <GmailLogo \/>/)
  assert.match(app, /icon === "ios"\) return <IosSimulatorLogo \/>/)
  assert.match(app, /icon === "godot"\) return <GodotLogo \/>/)
  assert.doesNotMatch(app, /icon === "gmail"[^;]*<Mail/)
  assert.doesNotMatch(app, /icon === "ios"[^;]*<Smartphone/)
  assert.doesNotMatch(app, /icon === "godot"[^;]*<Gamepad2/)
  assert.match(app, /credentialPlugin = selected\.connector\.auth === "pat" \|\| selected\.connector\.auth === "oauth" \|\| selected\.connector\.auth === "api-key"/)
  assert.match(app, /selected\.id === "gmail"[\s\S]*OAuth desktop client JSON/)
  assert.match(app, /gmailOAuthClient\.trim\(\)/)
  assert.match(app, /\(!connectionState\?\.connected \|\| !credentialPlugin \|\| authorizationExpanded\) && <footer>/)
  assert.match(app, /setEditingAuthorization\(selected\.id\)/)
  assert.match(app, /t\("Modify", "修改"\)/)
  assert.match(app, /GitHub CLI login/)
  assert.match(app, /connectionState\.status === "error" \|\| connectionState\.status === "unavailable"/)
  assert.doesNotMatch(app, /connectionState\?\.message && !connectionState\.connected/)
  assert.match(app, /connectionState\?\.connected && <div class="plugin-connection-row plugin-enabled-row"/)
  assert.match(app, /plugin-dialog-actions[\s\S]*plugin-dialog-more[\s\S]*plugin-dialog-menu[\s\S]*Modify[\s\S]*Remove/)
  assert.match(app, /plugin-dialog-menu[\s\S]*setEditingAuthorization\(selected\.id\); setPluginActionsOpen\(false\)/)
  assert.match(app, /<footer>\{selected\.connector\.setupUrl[\s\S]*Setup guide/)
  assert.doesNotMatch(app, /<footer><span \/>\{selected\.connector\.setupUrl/)
  assert.match(css, /\.plugin-dialog > footer \{[^}]*grid-template-columns: 1fr auto;/)
  assert.match(css, /\.plugin-dialog > footer a \{[^}]*padding: 0 10px 0 0;/)
  assert.doesNotMatch(app, /<footer><button class="plugin-danger"/)
  assert.match(app, /plugin-auth-state[\s\S]*title=\{connectionState\?\.account/)
  assert.match(app, /t\("Authorizing…", "授权中…"\)/)
  assert.match(app, /t\("Testing connection…", "正在测试连接…"\)/)
  assert.match(app, /<KeyRound \/>[\s\S]*t\("Update authorization", "更新授权"\)/)
  assert.doesNotMatch(app, /<ExternalLink \/>\{connectionState\?\.connected/)
  assert.doesNotMatch(app, /t\("Reconnect", "重新连接"\)/)
  assert.doesNotMatch(app, /Figma 尚未批准 Shun|Official remote MCP server|github-mcp-server/)
  assert.doesNotMatch(app.slice(app.indexOf('function PluginHub'), app.indexOf('function PluginLogo')), />\{t\("Test", "测试"\)\}</)
  assert.doesNotMatch(settings, /setTab\("plugins"\)|<PluginHub/)
  assert.doesNotMatch(app.slice(app.indexOf('function PluginHub'), app.indexOf('function PluginLogo')), /Personal plugins|Local plugin|plugin-search|plugin-add|Connect GitHub and Figma|Small-model friendly|Local MCP URL|Executable/)
  assert.match(css, /\.plugin-catalog-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/)
  assert.match(css, /\.plugin-catalog-grid\s*\{[^}]*column-gap:\s*12px/)
  assert.match(css, /\.plugin-catalog-grid\s*\{[^}]*row-gap:\s*8px/)
  assert.match(css, /\.skill-grid\s*\{[^}]*gap:\s*4px 12px/)
  assert.match(css, /\.installed-plugin-strip \{[^}]*padding: 16px 0;/)
  assert.match(css, /\.installed-plugin-strip > button \{[^}]*width: 36px;[^}]*height: 36px;/)
  assert.match(css, /\.plugin-catalog-row\s*\{[^}]*padding: 8px;[^}]*background: color-mix\(in srgb,var\(--surface-2\) 42%,transparent\);/)
  assert.doesNotMatch(css, /\.plugin-catalog-row\s*\{[^}]*margin: 0 -8px;/)
  assert.match(css, /\.chrome-glyph\s*\{[^}]*width: 22px;[^}]*conic-gradient\([^}]*#ea4335[^}]*#fbbc04[^}]*#34a853/)
  assert.match(css, /\.chrome-glyph:before\s*\{[^}]*inset: 5px;[^}]*border: 1\.5px solid #fff;[^}]*background: #4285f4/)
  assert.doesNotMatch(css, /\.chrome-glyph:after/)
  assert.match(css, /\.skill-row \{[^}]*padding: 8px;[^}]*background: color-mix\(in srgb,var\(--surface-2\) 42%,transparent\);/)
  assert.doesNotMatch(css, /\.skill-row \{[^}]*margin: 0 -8px;/)
  assert.match(css, /\.skill-discard-backdrop \{[^}]*z-index:190;/)
  assert.match(css, /\.skill-discard-dialog button\.danger \{[^}]*background:#a8424c;[^}]*color:#fff;/)
  assert.match(css, /\.plugin-dialog\s*\{[^}]*width:\s*min\(430px/)
  assert.match(css, /\.plugin-auth-state\s*\{[^}]*max-width:\s*176px/)
  assert.match(css, /\.plugin-auth-state > span\s*\{[^}]*text-overflow:\s*ellipsis/)
  assert.match(css, /\.plugin-page-heading \{[^}]*display:flex;[^}]*justify-content:space-between;/)
  assert.match(css, /\.plugin-page-heading h1 \{[^}]*margin: 0;/)
  assert.match(css, /\.plugin-page-heading > button \{[^}]*height:28px;[^}]*border:1px solid transparent;[^}]*background:transparent;/)
  assert.match(css, /\.plugin-page-heading > button:hover \{[^}]*background:var\(--hover-bg\);/)
  assert.match(css, /\.plugin-page-heading p \{[^}]*margin: 0 0 29px;/)
  assert.doesNotMatch(app, /mcpServers: \[\],\s*\n\s*\}\);/)
})

test('scheduled task controls stay bounded and use one polished product picker language', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/schedule-page.css', import.meta.url), 'utf8'),
  ])
  const editor = app.slice(app.indexOf('function ScheduleEditor'), app.indexOf('function scheduleDraft'))
  const taskPicker = app.slice(app.indexOf('function ScheduleTaskPicker'), app.indexOf('function scheduleTaskLocation'))

  assert.doesNotMatch(editor, /<select/)
  assert.match(editor, /<ScheduleTaskPicker/)
  assert.match(editor, /<ScheduleSelect label=/)
  assert.match(editor, /<ScheduleTimeControl mode="time"/)
  assert.match(taskPicker, /sort\(\(a, b\) => b\.updatedAt - a\.updatedAt\)/)
  assert.match(taskPicker, /searchLimit = 18, recentLimit = 6/)
  assert.match(taskPicker, /task\.title === 'New task' && !hasTaskMessages\(task\)/)
  assert.match(taskPicker, /Recent conversations/)
  assert.match(taskPicker, /visible = matching\.slice\(0, normalized \? searchLimit : recentLimit \+ 2\)/)
  assert.match(taskPicker, /Search tasks or projects/)
  assert.match(css, /\.schedule-task-results\{max-height:252px;/)
  assert.match(css, /\.schedule-task-section\{display:block;padding:8px 8px 4px;/)
  assert.match(css, /\.schedule-choice-trigger>svg,[^}]*width:14px;height:14px;/)
  assert.match(css, /input::-webkit-calendar-picker-indicator\{[^}]*opacity:0;/)
})

test('every loading circle uses the single global animated loading indicator', async () => {
  const [app, index, css, refine, updateCss] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/loading.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app-update.css', import.meta.url), 'utf8'),
  ])
  const loaders = app.match(/<LoaderCircle\b[^>]*>/g) || []
  const directLoaders = loaders.filter((loader) => /class="[^"]*loading-spinner/.test(loader))

  assert.ok(loaders.length > 0)
  assert.equal(loaders.length - directLoaders.length, 1)
  assert.match(app, /<span class="task-spinner loading-spinner"[^>]*>\s*<LoaderCircle aria-hidden="true" \/>/)
  assert.match(index, /import '\.\/loading\.css'/)
  assert.match(css, /\.loading-spinner[\s\S]*animation:\s*shun-loading-spin[^;]*infinite\s*!important/)
  assert.match(css, /animation:\s*shun-loading-spin 1\.4s linear infinite !important/)
  assert.doesNotMatch(refine, /@keyframes task-spin\b|\.task-spinner svg\{[^}]*animation/)
  assert.doesNotMatch(updateCss, /@keyframes task-spin\b|animation:\s*task-spin\b/)
})

test('global toasts provide compact reusable feedback above modal surfaces', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /<ToastViewport items=\{toasts\} \/>/)
  assert.match(app, /notify=\{notify\}/)
  assert.match(app, /aria-live="polite"/)
  assert.match(css, /Global feedback stays quiet, compact, and independent from modal surfaces\./)
  assert.match(css, /\.toast-viewport\{[^}]*position:fixed;[^}]*z-index:240;[^}]*top:60px;[^}]*left:264px;[^}]*right:0;[^}]*align-items:center/)
  assert.match(css, /\.shell\.sidebar-collapsed>\.toast-viewport\{left:0\}/)
  assert.match(css, /@media\(max-width:1000px\) and \(min-width:761px\)\{\.toast-viewport\{left:220px\}/)
  assert.match(css, /@media\(max-width:760px\)\{\.toast-viewport,\.shell\.sidebar-collapsed>\.toast-viewport\{left:0\}/)
  assert.doesNotMatch(css, /@media\(max-width:680px\)\{\.toast-viewport\{top:/)
  assert.doesNotMatch(app, /aria-label="Dismiss"/)
  assert.match(app, /class="toast-copy"/)
  assert.match(css, /\.app-toast\{[^}]*height:34px;[^}]*backdrop-filter:[^}]*display:flex;[^}]*animation:toast-arrive/)
  assert.match(css, /\.app-toast \.toast-copy\{[^}]*white-space:nowrap/)
})

test('message copy actions report clipboard success and failure through global toasts', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')

  assert.match(app, /async function copyText\(value: string\)/)
  assert.match(app, /await navigator\.clipboard\.writeText\(value\)/)
  assert.match(app, /notify\(\{ tone: "success", title: zh \? "已复制" : "Copied" \}\)/)
  assert.match(app, /notify\(\{ tone: "error", title: zh \? "复制失败" : "Copy failed" \}\)/)
  assert.match(app, /<TaskHistory[\s\S]*copyText=\{copyText\}/)
  assert.match(app, /onClick=\{\(\) => void copyText\(turn\.content\)\}/)
  assert.match(app, /if \(last\) void copyText\(last\.content\)/)
})

test('model defaults select provider-owned deployments without duplicating their limits', async () => {
  const [app, runtime, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./agent-runtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])
  const start = app.indexOf('{tab === "model" && active && <section>')
  const end = app.indexOf('{tab === "appearance"', start)
  const panel = app.slice(start, end)

  assert.ok(start > -1 && end > start)
  assert.match(app, /t\("Model defaults", "模型默认项"\)/)
  assert.match(panel, /Providers define deployments; this page only chooses which one to use\./)
  assert.match(panel, /Read-only here\. Context and output limits are edited under Providers\./)
  assert.doesNotMatch(panel, /editModel\(/)
  assert.doesNotMatch(panel, /type="checkbox"/)
  assert.match(panel, /class="always-on"/)
  assert.match(runtime, /setAutoCompactionEnabled\(true\)/)
  assert.match(css, /Provider pages define deployments; model defaults only select and consume them\./)
})

test('user messages share the composer surface', async () => {
  const [css, messageLayout, markdownCss] = await Promise.all([
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/message-layout.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/trace-polish.css', import.meta.url), 'utf8'),
  ])

  assert.match(css, /\.user \.body\{border-color:var\(--composer-border\);background:var\(--composer-bg\)/)
  assert.match(css, /\.feed article\.user\{margin-bottom:40px\}/)
  assert.match(messageLayout, /\.user \.copy ul,\.user \.copy ol\{--user-list-indent:/)
  assert.match(messageLayout, /li:has\(>input\[type="checkbox"\]:first-child\)\{list-style:none\}/)
  assert.match(messageLayout, /margin-inline:calc\(0px - var\(--user-list-indent\)\) calc\(var\(--user-list-indent\) - 13px\)/)
  assert.match(markdownCss, /\.copy \.code-shell pre\{margin:0;padding:11px 13px;/)
})

test('completed responses do not expose task forking', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(app, /GitFork|Fork task here|从这里派生任务|name: "\/fork"/)
})

test('native fullscreen removes the macOS traffic-light inset from sidebar controls', async () => {
  const [main, preload, app, css] = await Promise.all([
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])

  assert.match(main, /window\.on\('enter-full-screen', sendWindowState\)/)
  assert.match(main, /window\.on\('leave-full-screen', sendWindowState\)/)
  assert.match(preload, /windowState: \(\) => ipcRenderer\.invoke\('window:state'\)/)
  assert.match(app, /fullscreen \? "window-fullscreen" : ""/)
  assert.match(css, /\.window-fullscreen \.sidebar-toggle,\.window-fullscreen \.sidebar-reveal\{left:19px\}/)
  assert.match(css, /\.window-fullscreen\.sidebar-collapsed \.stage>header\{padding-left:60px\}/)
})

test('a queued prompt waits only for its own task, not for another active tab', () => {
  const active = { 'task-a': 'run-a' }
  const queue = [
    { id: 'queued-a', taskId: 'task-a', text: 'follow up A' },
    { id: 'queued-b', taskId: 'task-b', text: 'start B' },
  ]
  assert.equal(nextRunnablePrompt(queue, active)?.id, 'queued-b')
})

test('successful conversational Skill mutations invalidate the slash-palette catalog immediately', async () => {
  for (const name of ['skill_create', 'skill_update', 'skill_install', 'skill_remove']) {
    assert.equal(toolChangesSkillCatalog({ name, state: 'done' }), true)
    assert.equal(toolChangesSkillCatalog({ name, state: 'running' }), false)
    assert.equal(toolChangesSkillCatalog({ name, state: 'error' }), false)
  }
  assert.equal(toolChangesSkillCatalog({ name: 'skill_search', state: 'done' }), false)

  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  assert.match(app, /toolChangesSkillCatalog\(event\.tool\)[\s\S]*setSkillCatalogRevision/)
  assert.match(app, /settings\.mcpServers, skillCatalogRevision\]/)
  assert.match(app, /onSkillsChanged=\{\(\) => setSkillCatalogRevision/)
  assert.match(app, /refreshSkills = async \(\) => \{[\s\S]*setSkills\(await window\.shun\.skills\(value\)\);[\s\S]*onSkillsChanged\(\)/)
})

test('queued prompt dispatch reserves a task before renderer state commits', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  assert.match(app, /queueReservations = useRef\(new Set<string>\(\)\)/)
  assert.match(app, /nextRunnablePrompt\(queued, \{ \.\.\.reserved, \.\.\.runningByTask \}\)/)
  assert.ok(app.indexOf('queueReservations.current.add(next.taskId)') < app.indexOf('runPrompt(next.text, target.turns', app.indexOf('queueReservations.current.add(next.taskId)')))
})

test('local paths in answers open through the controlled Desktop boundary', async () => {
  const [app, preload, main, capabilities] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./capabilities.ts', import.meta.url), 'utf8'),
  ])
  assert.match(app, /window\.shun\.openLocalPath\(path\)/)
  assert.match(app, /localPathCandidate\(source\)/)
  assert.match(preload, /openLocalPath: path => ipcRenderer\.invoke\('local-path:open', path\)/)
  assert.match(main, /ipcMain\.handle\('local-path:open'/)
  assert.match(main, /target\.kind === 'file'[\s\S]*shell\.showItemInFolder\(target\.path\)/)
  assert.match(app, /className = "local-file-link"[\s\S]*localPathDisplayName\(localPath\)[\s\S]*pre\.replaceWith\(link\)/)
  assert.match(capabilities, /visible label is only the file or folder name/)
})

test('running-task messages queue by default and only an explicit action interrupts', async () => {
  const [app, main, preload] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../preload/index.ts', import.meta.url), 'utf8'),
  ])

  assert.match(app, /if \(running\) \{\s*if \(immediate\)[\s\S]*setQueued/)
  assert.match(app, /submit\(Boolean\(running && \(e\.metaKey \|\| e\.ctrlKey\)\)\)/)
  assert.doesNotMatch(app, /Enter to queue|⌘\/Ctrl\+Enter 立即发送/)
  assert.match(app, /class="queue-send-now"[\s\S]*onClick=\{\(\) => sendQueuedNow\(x\)\}/)
  assert.match(app, /class="queue-edit"[\s\S]*onClick=\{\(\) => editQueuedPrompt\(x\)\}/)
  assert.match(app, /function editQueuedPrompt[\s\S]*hasDraft[\s\S]*setText\(item\.text\)/)
  assert.match(app, /window\.shun\.interrupt\(request\)/)
  assert.match(preload, /interrupt: req => ipcRenderer\.invoke\('agent:interrupt', req\)/)
  const handler = main.slice(main.indexOf("ipcMain.handle('agent:interrupt'"), main.indexOf("ipcMain.handle('agent:revise'"))
  assert.ok(handler.indexOf('await stopActiveTaskRun(req.taskId)') < handler.indexOf('startAgentRun(req, event.sender)'))
})

test('queued status stays below composer and context popovers', async () => {
  const [css, interaction] = await Promise.all([
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/interaction-fix.css', import.meta.url), 'utf8'),
  ])

  assert.match(css, /\.queue\{position:absolute;z-index:0;/)
  assert.match(interaction, /\.context-strip\{position:relative;z-index:1;/)
  assert.match(interaction, /\.composer\{position:relative;z-index:2\}/)
})

test('editing a user message confirms workspace rewind and starts a conversation revision', async () => {
  const [app, main, runtime] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./agent-runtime.ts', import.meta.url), 'utf8'),
  ])

  assert.match(app, /revisionPreview\(task\.id, messageId, task\.workspace\)/)
  assert.match(app, /turns\.slice\(0, index\)/)
  assert.match(app, /kind: "revision", targetMessageId: messageId/)
  assert.match(app, /外部副作用[\s\S]*External side effects/)
  assert.match(app, /<FilePenLine \/>[\s\S]*zh \? "编辑" : "Edit"/)
  assert.match(main, /conversationCheckpoints\.restore\(sessionId, req\.revision\.targetMessageId, cwd\)/)
  assert.match(runtime, /if \(options\.branchFrom\)[\s\S]*sessionManager\.branch[\s\S]*sessionManager\.resetLeaf/)
})

test('finishing one run preserves every other task run', () => {
  const active = { 'task-a': 'run-a', 'task-b': 'run-b' }
  assert.deepEqual(finishTaskRun(active, 'run-a'), { 'task-b': 'run-b' })
  assert.strictEqual(finishTaskRun(active, 'unknown'), active)
})

test('background processes never keep the model-run spinner alive', () => {
  const background = {
    id: 'server-1', sessionId: 'task-a', createdByRunId: 'run-a', workspace: '/project', command: 'pnpm dev', label: 'dev server', state: 'running' as const,
    createdAt: 1, outputSeq: 0, outputBytes: 0, endpoints: ['http://localhost:5174'],
  }

  assert.equal(taskRunIsActive({}, 'task-a'), false)
  assert.equal(taskHasActiveBackground([background]), true)
  assert.equal(taskRunIsActive({ 'task-a': 'run-a' }, 'task-a'), true)
})

test('the environment popover follows the current task instead of aggregating other conversations', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/background-processes.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /backgrounds = backgroundByTask\[currentId\] \|\| \[\]/)
  assert.match(app, /activeBackgroundCount = backgrounds\.filter/)
  assert.match(app, /<EnvironmentPanel[\s\S]*items=\{backgrounds\}/)
  assert.match(app, /repository=\{repository\}[\s\S]*changeCount=\{repository\?\.files\.length \?\? changeCount\}[\s\S]*attachments=\{task\?\.attachments \|\| \[\]\}/)
  assert.match(app, /Current task environment/)
  assert.doesNotMatch(app, /allBackgrounds/)
  assert.doesNotMatch(app, /sources=\{environmentSources\}/)
  assert.match(app, /\{attachments\.length > 0 && <>/)
  assert.match(app, /class="environment-source"[\s\S]*<AttachmentThumbnail item=\{attachment\} className="environment-source-thumb"/)
  assert.match(app, /environment-source-copy[\s\S]*attachmentLabel\(attachment\)[\s\S]*formatAttachmentSize\(attachment\.size\)/)
  assert.match(app, /function AttachmentThumbnail[\s\S]*previewAttachment\(item\.taskId, item\.id, 1, 'model'\)/)
  assert.match(app, /environment-context\$\{activeItems\.length > 0 \? ' has-processes' : ''\}/)
  assert.doesNotMatch(app, /browserByTask|Chrome sessions|Chrome 会话|browser-session/)
  assert.match(css, /\.environment-context/)
  assert.match(css, /\.background-manager \{[\s\S]*grid-template-rows: 40px minmax\(0, 1fr\);/)
  assert.match(css, /\.background-manager > header \{[\s\S]*height: 40px;/)
  assert.match(css, /\.background-manager-list \{[\s\S]*padding: 2px 7px 7px;/)
  assert.match(css, /\.environment-context \{\s*padding: 0;/)
  assert.match(css, /\.environment-context\.has-processes[\s\S]*border-bottom:/)
  assert.doesNotMatch(css, /\.environment-context \{[^}]*border-bottom:/)
  assert.match(css, /\.environment-sources/)
  assert.match(css, /\.environment-sources \.environment-source-thumb \{[\s\S]*width: 40px;[\s\S]*height: 36px;/)
  assert.match(css, /\.environment-sources \.environment-source-thumb img \{[\s\S]*object-fit: cover;/)
  assert.match(css, /\.environment-context > button:hover,[\s\S]*background: var\(--sidebar-hover-bg\)/)
  assert.match(css, /\.background-process:hover,[\s\S]*background: var\(--sidebar-hover-bg\)/)
  assert.doesNotMatch(css, /\.browser-session/)
  assert.doesNotMatch(css, /background: var\(--hover-bg\)/)
  assert.doesNotMatch(css, /var\(--hover-bg,\s*#[0-9a-f]+\)/i)
})

test('workspace change counts never leak into standalone drafts', () => {
  assert.equal(visibleWorkspaceChangeCount(undefined, 22, 8), 0)
  assert.equal(visibleWorkspaceChangeCount('', 22, 8), 0)
  assert.equal(visibleWorkspaceChangeCount('/project', 22, 8), 22)
  assert.equal(visibleWorkspaceChangeCount('/project', undefined, 8), 8)
})

test('streaming grows into its initial viewport and only follows after reaching the composer', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])

  assert.equal(feedScrollModeAfterScroll('follow-bottom', true), 'follow-bottom')
  assert.equal(feedScrollModeAfterScroll('follow-stream', true), 'follow-stream')
  assert.equal(feedScrollModeAfterScroll('follow-stream', false), 'free')
  assert.equal(feedScrollModeAfterScroll('follow-bottom', false), 'free')
  assert.equal(feedScrollModeAfterScroll('free', false), 'free')
  assert.equal(streamedFeedScrollTop({ scrollTop: 200, latestBottom: 700, composerTop: 760, revealGap: 24, maxScrollTop: 1_000 }), 200)
  assert.equal(streamedFeedScrollTop({ scrollTop: 200, latestBottom: 750, composerTop: 760, revealGap: 24, maxScrollTop: 1_000 }), 214)
  assert.equal(streamedFeedScrollTop({ scrollTop: 980, latestBottom: 800, composerTop: 760, revealGap: 24, maxScrollTop: 1_000 }), 1_000)
  const turns = [
    { id: 'user-1', role: 'user' as const, content: 'prompt' },
    { id: 'run-1', role: 'assistant' as const, content: '', phase: 'Thinking' },
  ]
  assert.equal(runningTurnAnchorId(turns, 'run-1'), 'user-1')
  assert.equal(runningTurnAnchorId(turns, 'missing'), 'missing')
  assert.match(app, /const feedAnchorGap = 35/)
  assert.match(app, /feedStreamRevealGap = 24/)
  assert.match(app, /pendingScrollTurn\.current = userId \|\| runId/)
  assert.match(app, /feedScrollMode\.current = 'follow-stream'/)
  assert.match(app, /runLayoutTask\.current = target\.id/)
  assert.match(app, /runLayoutTask\.current === currentId \? "run-anchored"/)
  assert.match(app, /runningTurnAnchorId\(next\.turns, activeRun\)/)
  assert.match(app, /anchorTop - feedTop - feedAnchorGap/)
  assert.match(app, /Math\.abs\(node\.scrollTop - target\) < 2/)
  assert.match(app, /streamedFeedScrollTop\(\{/)
  assert.match(app, /latest\.getBoundingClientRect\(\)\.bottom/)
  assert.match(app, /composerEdge\.getBoundingClientRect\(\)\.top/)
  assert.match(app, /settlingScrollTurn\.current = event\.id/)
  assert.match(app, /new ResizeObserver\(follow\)/)
  assert.match(app, /onWheel=\{\(\) => \{[\s\S]*feedScrollMode\.current = 'free'/)
  assert.match(app, /\}, \[turns, running\]\)/)
  assert.match(css, /\.feed article\{scroll-margin-top:35px\}/)
  assert.match(css, /\.feed\.run-anchored\{overflow-anchor:none\}/)
  assert.match(css, /\.feed\.run-anchored \.conversation-turn:last-child\{min-height:max\(0px,calc\(100vh - 48px - 190px\)\)\}/)
  assert.doesNotMatch(css, /\.feed\.run-anchored\{[^}]*padding-bottom:/)
  assert.match(app, /groupConversationTurns\(visible\)/)
  assert.doesNotMatch(css, /\.feed\.run-active/)
  assert.doesNotMatch(app, /lockedFeedScrollTop|anchored-turn|atBottom/)
})

test('group summaries disclose failures only when every action failed', () => {
  assert.equal(summarizedFailureCount(2, 3), 0)
  assert.equal(summarizedFailureCount(2, 2), 2)
  assert.equal(summarizedFailureCount(0, 0), 0)
})

test('web research summaries name the action and keep the concrete query visible', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  assert.match(app, /reading \? "正在读取网页" : "正在搜索网页"/)
  assert.match(app, /reading \? "Reading web page" : "Searching web"/)
  assert.match(app, /: "已搜索网页"[\s\S]*: "Searched web"[\s\S]*detail,/)
  assert.doesNotMatch(app, /`搜索 \$\{searches\.size\} 次`|`\$\{searches\.size\} \$\{searches\.size === 1 \? "search" : "searches"\}`/)
  assert.match(app, /Read \$\{opened\.size\} web \$\{opened\.size === 1 \? "page" : "pages"\}/)
  assert.doesNotMatch(app, /已打开 \$\{opened\.size\} 个来源|Opened \$\{opened\.size\} sources/)
})

test('plugin discovery and Cloudflare groups use product language without raw discovery fallbacks', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  assert.match(app, /pluginDiscoveryOnly[\s\S]*已准备插件工具[\s\S]*Prepared plugin tools/)
  assert.match(app, /cloudflareOnly[\s\S]*已查询 Cloudflare[\s\S]*Queried Cloudflare/)
  assert.match(app, /tool\.name === "plugin_tool_search"[\s\S]*\? ""/)
})

test('closed Mermaid blocks render before the rest of a response finishes streaming', () => {
  assert.equal(completedMermaidBlockCount('```mermaid\ngraph TD\n  A-->B\n```\nMore text is streaming'), 1)
  assert.equal(completedMermaidBlockCount('```mermaid\ngraph TD\n  A-->B'), 0)
  assert.equal(completedMermaidBlockCount('~~~mermaid\nsequenceDiagram\n  A->>B: Hi\n~~~'), 1)
  assert.equal(completedMermaidBlockCount('```ts\nconst value = 1\n```\n```mermaid\ngraph LR\n  A-->B\n```'), 1)
})

test('expanded diagrams omit the redundant title and use quiet light-theme actions', async () => {
  const [app, mermaidCss, finalCss] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/mermaid.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])
  assert.doesNotMatch(app, /title = document\.createElement\("strong"\)|title\.textContent = "Diagram"|modalHead\.append\(title/)
  assert.match(app, /modalHead\.append\(actions\)/)
  for (const css of [mermaidCss, finalCss]) {
    assert.match(css, /\.diagram-modal-actions button\.active\{background:#f0f0f0;color:#3c3c3c\}/)
    assert.match(css, /\.diagram-modal-actions \.diagram-modal-close\{background:transparent;color:#8f8f8f\}/)
    assert.match(css, /\.diagram-modal-actions \.diagram-modal-close:hover\{background:#f6f6f6;color:#636363\}/)
  }
})

test('renderer surfaces use neutral grays instead of cool gray literals', async () => {
  const directory = new URL('../renderer/src/', import.meta.url)
  const names = (await import('node:fs/promises')).readdir(directory)
  const offenders: string[] = []
  for (const name of (await names).filter(name => /\.(?:css|tsx)$/.test(name))) {
    const source = await readFile(new URL(name, directory), 'utf8')
    for (const match of source.matchAll(/#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?\b/g)) {
      const red = Number.parseInt(match[1].slice(0, 2), 16), green = Number.parseInt(match[1].slice(2, 4), 16), blue = Number.parseInt(match[1].slice(4, 6), 16)
      if (blue > red && blue >= green && green >= red && blue - red <= 32) offenders.push(`${name}:${match[0]}`)
    }
    for (const match of source.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g)) {
      const red = Number(match[1]), green = Number(match[2]), blue = Number(match[3])
      if (blue > red && blue >= green && green >= red && blue - red <= 32) offenders.push(`${name}:${match[0]}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('message markdown renders inline and display formulas through KaTeX', () => {
  const engine = new Marked(markedMathExtension)
  const html = engine.parse('Inline $E = mc^2$.\n\n$$\\hbar \\frac{\\partial}{\\partial t} \\Psi = \\hat{H} \\Psi$$\n\n`$literal$`') as string

  assert.match(html, /class="math-source" data-katex="E%20%3D%20mc%5E2" data-display="false"/)
  assert.match(html, /data-display="true"/)
  assert.match(html, /<code>\$literal\$<\/code>/)
  assert.doesNotMatch(engine.parse('It costs $5 and $10 after tax.') as string, /class="math-source"/)
})

test('flowcharts become stable native Excalidraw elements', () => {
  const palette = { bg: '#fff', fg: '#222', line: '#555', surface: '#fff', border: '#777', muted: '#666' }
  const elements = buildExcalidrawFlowSkeleton('flowchart TD\n  A[Start] --> B{Ready?}\n  B --> C[Ship]', palette)
  assert.ok(elements)
  assert.equal(elements.filter((element) => element.type === 'rectangle').length, 2)
  assert.equal(elements.filter((element) => element.type === 'diamond').length, 1)
  assert.equal(elements.filter((element) => element.type === 'arrow').length, 2)
  const arrow = elements.find((element) => element.type === 'arrow') as { roughness?: number; label?: { fontFamily?: number } }
  const node = elements.find((element) => element.type === 'rectangle') as { label?: { fontFamily?: number; fontSize?: number } }
  assert.equal(arrow.roughness, 2)
  assert.equal(node.label?.fontFamily, 5)
  assert.equal(node.label?.fontSize, 16)
  assert.equal(stableExcalidrawSeed('node:A'), stableExcalidrawSeed('node:A'))
  assert.notEqual(stableExcalidrawSeed('node:A'), stableExcalidrawSeed('node:B'))
})

test('remote task lifecycle commands enforce Desktop model, rename, archive, and delete invariants', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  assert.match(app, /request\.kind === 'task\.model'/)
  assert.match(app, /providerModels\.some\(item => item\.id === model\)/)
  assert.match(app, /window\.shun\.save\(stateForStorage\(settings, nextTasks, currentId\)\)/)
  assert.match(app, /request\.kind === 'task\.rename'/)
  assert.match(app, /request\.kind === 'task\.archive'/)
  assert.match(app, /request\.kind === 'task\.delete'/)
  assert.match(app, /Stop the task before archiving it/)
  assert.match(app, /Stop background processes before deleting this task/)
  assert.match(app, /await window\.shun\.deleteTaskData\(taskId\)/)
})

test('Desktop keeps one owner for the shared remote connection', async () => {
  const main = await readFile(new URL('index.ts', import.meta.url), 'utf8')
  assert.match(main, /app\.requestSingleInstanceLock\(\)/)
  assert.match(main, /app\.on\('second-instance'/)
  assert.match(main, /if \(!primaryInstance\) return/)
})

test('remote task creation starts the first message atomically and keeps create-only requests durable', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const create = app.slice(app.indexOf('if (request.kind === "task.create")'), app.indexOf('if (request.kind === "task.snapshot")'))
  const send = app.slice(app.indexOf('if (request.kind === "task.message.send")'), app.indexOf('if (request.kind === "task.message.enqueue")'))

  assert.match(create, /const persisted = stateForStorage\(settings, initialRunId \? tasksRef\.current : nextTasks, created\.id\)/)
  assert.match(create, /typeof payload\.workspace === "string"[\s\S]*\? payload\.workspace[\s\S]*: \(settings\.workspace \|\| ""\)/)
  assert.doesNotMatch(create, /payload\.workspace \|\| settings\.workspace/)
  assert.match(create, /initialMessage[\s\S]*runPrompt\(initialText, created\.turns, created[\s\S]*if \(initialRunId\) void window\.shun\.save\(persisted\)\.catch/)
  assert.match(create, /else await window\.shun\.save\(persisted\)[\s\S]*return remoteTaskList/)
  assert.doesNotMatch(create, /payload\.taskId/)
  assert.match(send, /runPrompt\([\s\S]*await window\.shun\.save\(stateForStorage\(settings, tasksRef\.current, currentId\)\)[\s\S]*return \{ accepted: true \}/)
})

test('remote task creation can browse Desktop folders and retain its selected model', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')

  assert.match(app, /request\.kind === "workspaces\.browse"[\s\S]*window\.shun\.browseWorkspaces/)
  assert.match(app, /request\.kind === "models\.list"[\s\S]*providerModels\.map/)
  assert.match(app, /providerModels\.some\(model => model\.id === payload\.model\)/)
  assert.match(app, /model: requestedModel \|\| undefined/)
  assert.match(app, /settingsForTask\(target\)/)
})

test('remote Desktop files use task-scoped metadata and bounded chunk commands', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')

  assert.match(app, /request\.kind === 'file\.download\.info'/)
  assert.match(app, /request\.kind === 'file\.download\.chunk'/)
  assert.match(app, /This file is not part of the task conversation or workspace/)
  assert.match(app, /window\.shun\.readRemoteFileChunk\(info\.path/)
})

test('the sidebar resizes without breaking the conversation and plugin grid', async () => {
  const [app, css, pluginCss] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/plugin-view-host.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /data-sidebar-resizer/)
  assert.match(app, /onPointerDown=\{beginSidebarResize\}/)
  assert.match(app, /onKeyDown=\{resizeSidebarWithKeyboard\}/)
  assert.match(app, /onDblClick=\{\(\) => setSidebarWidth\(defaultSidebarWidth\(\)\)\}/)
  assert.match(app, /style=\{`--sidebar-width:\$\{sidebarWidth\}px`\}/)
  assert.match(css, /grid-template-columns:var\(--sidebar-width\) minmax\(0,1fr\)/)
  assert.match(css, /\.shell\.sidebar-resizing \.stage,\.shell\.sidebar-resizing \.plugin-view-host\{pointer-events:none\}/)
  assert.match(pluginCss, /\.shell\.plugin-view-open\s*\{\s*grid-template-columns:\s*var\(--sidebar-width, 264px\) minmax\(360px, 1fr\) auto/)
  assert.match(pluginCss, /\.shell\.sidebar-collapsed\.plugin-view-open\s*\{\s*grid-template-columns:\s*0 minmax\(360px, 1fr\) auto/)
})

test('workspace review opens Git Workbench and modal veils cover shell chrome', async () => {
  const [app, css, main] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
  ])

  assert.match(app, /plugins: applyDefaultPluginInstallations\(\{ plugins: \[\] \}\)\.plugins/)
  assert.match(main, /state\.settings = applyDefaultPluginInstallations\(migratePluginSettings\(state\.settings\)\)/)
  assert.match(main, /parsed\.settings = applyDefaultPluginInstallations\(migratePluginSettings\(parsed\.settings\)\)/)
  assert.match(app, /function openGitWorkbench\(\)[\s\S]*setOpenPluginViewId\(key\)/)
  assert.match(app, /function review\(\) \{[\s\S]*openGitWorkbench\(\)/)
  assert.doesNotMatch(app, /<DiffView text=/)
  assert.doesNotMatch(app, /function DiffView\(/)
  assert.match(css, /\.veil\{z-index:70;background:var\(--overlay-bg\)\}/)
  assert.match(css, /\.sidebar-resizer\{[^}]*z-index:31/)
})

test('Git Workbench clears stale repository data and offers a bounded non-Git workspace state', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../../resources/plugins/git-workbench/ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../resources/plugins/git-workbench/ui/styles.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /if \(changed\) \{\s*resetWorkspaceState\(\)/)
  assert.match(app, /state\.overview = null; state\.unavailable = ''/)
  assert.match(app, /result\?\.unavailable === 'not-repository'/)
  assert.match(app, /data-empty-action="init"/)
  assert.match(app, /data-empty-action="retry"/)
  assert.match(app, /data-reveal="\."/)
  assert.match(css, /\.repository-unavailable \{[^}]*place-items: center/)
})

test('Git Workbench keeps SourceTree-style actions, file rows, and remote hierarchy functional', async () => {
  const [app, css, html, manifest, host, repository, main] = await Promise.all([
    readFile(new URL('../../resources/plugins/git-workbench/ui/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../resources/plugins/git-workbench/ui/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../../resources/plugins/git-workbench/ui/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../../resources/plugins/git-workbench/manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/plugin-view-host.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./repository.ts', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
  ])

  for (const action of ['commit', 'pull', 'push', 'fetch', 'create-branch', 'merge', 'stash']) assert.match(app, new RegExp(`\\['${action}',`))
  assert.match(app, /data-stage-file/)
  assert.match(app, /data-file-menu/)
  assert.match(app, /executeGit\(button\.dataset\.staged === 'true' \? 'unstage' : 'stage'/)
  assert.match(app, /class="remote-root" data-remote-toggle/)
  assert.match(app, /class="ref-item remote-branch/)
  assert.doesNotMatch(app, /class="remote-url"/)
  assert.match(app, /if \(!inHunk \|\| line === '\\\\ No newline at end of file'\) return ''/)
  assert.match(css, /\.file-row \{[^}]*height: 29px/)
  assert.doesNotMatch(css, /\.operations span \{[^}]*display: none/)
  assert.match(app, /正在获取远程更新/)
  assert.match(app, /class="notice progress" role="status"/)
  assert.match(app, /if \(kind === 'error'\) \{ noticeDismissTimer = 0; return \}/)
  assert.match(app, /noticeDismissTimer = setTimeout\(\(\) => \{[\s\S]*if \(state\.notice !== notice\) return[\s\S]*\}, 2600\)/)
  assert.match(app, /addEventListener\('click', dismissNotice\)/)
  assert.match(app, /document\.execCommand\('copy'\)/)
  assert.match(app, /busyPath: ''/)
  assert.match(app, /fileActionPending \? loadingRing\('file-spinner'\)/)
  assert.match(app, /action === 'reset-file' \? optimisticallyDiscardFiles/)
  assert.match(app, /state\.busy = ''; state\.busyPath = ''; showNotice\(message, 'success'\)[\s\S]*void loadOverview/)
  assert.match(app, /class="refresh \$\{state\.refreshing \? 'is-pending'/)
  assert.match(app, /running \? loadingRing\('operation-spinner'\) : gitIcon\(icon\)/)
  assert.doesNotMatch(app, /running \? gitIcon\('busy'\)/)
  assert.match(app, /data-menu-action="\$\{action\}"/)
  assert.match(app, /reset-to-commit/)
  assert.match(app, /action === 'reset-file'/)
  assert.match(app, /function positionContextMenu\(\)/)
  assert.match(app, /document\.documentElement\.clientWidth/)
  assert.match(app, /element\.style\.visibility = 'visible'/)
  assert.match(css, /\.operations button\.running/)
  assert.match(css, /\.operations button \{[^}]*width: 43px;[^}]*min-width: 43px/)
  assert.doesNotMatch(css, /\.operations button\.running \{[^}]*min-width/)
  assert.match(app, /<span>\$\{label\}<\/span>/)
  assert.doesNotMatch(app, /<span>\$\{running \? actionProgressLabel\(action, zh\) : label\}<\/span>/)
  assert.match(css, /\.spinner \{[^}]*border-top-color: transparent;[^}]*border-radius: 50%;[^}]*animation: spin/)
  assert.match(css, /\.file-spinner \{[^}]*width: 13px;[^}]*border-width: 1\.5px/)
  assert.doesNotMatch(css, /button\.is-pending > \.icon/)
  assert.doesNotMatch(css, /\.file-row\.is-pending \.status \{ animation: spin/)
  assert.match(app, /class="file-directory"/)
  assert.match(app, /class="file-name"/)
  assert.match(app, /refsCollapsed: true/)
  assert.match(app, /data-action="toggle-refs" aria-expanded=/)
  assert.match(app, /loadOverview\('HEAD', true\)/)
  assert.match(app, /data-dialog-submit/)
  assert.match(app, /querySelector\('\[data-dialog-submit\]'\)\?\.addEventListener\('click'/)
  assert.match(app, /class="git-dialog" role="dialog" aria-modal="true"/)
  assert.doesNotMatch(app, /<form class="git-dialog"/)
  assert.match(css, /\.body\.refs-collapsed \{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
  assert.doesNotMatch(host, /Experimental plugin/)
  assert.match(css, /\.file-directory \{[^}]*direction: rtl;[^}]*text-overflow: ellipsis/)
  assert.match(css, /\.file-name \{[^}]*flex: 0 0 auto;[^}]*max-width: 100%/)
  assert.match(css, /\.context-menu \{[^}]*max-height: calc\(100vh - 12px\)/)
  assert.match(host, /allow="clipboard-write"/)
  assert.match(repository, /GIT_TERMINAL_PROMPT: '0'/)
  assert.match(repository, /GCM_INTERACTIVE: 'Never'/)
  assert.match(html, /styles\.css\?v=0\.2\.13/)
  assert.match(html, /app\.js\?v=0\.2\.13/)
  assert.equal(JSON.parse(manifest).version, '0.2.13')
  assert.match(main, /headers\.set\('Cache-Control', 'no-store, max-age=0'\)/)
})
