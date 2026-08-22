import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Marked } from 'marked'
import { buildExcalidrawFlowSkeleton, stableExcalidrawSeed } from '../renderer/src/mermaid/excalidraw-flow-model.ts'
import { accentColor, accentOptions } from '../renderer/src/accent.ts'
import { markedMathExtension } from '../renderer/src/math-markdown.ts'
import { completedMermaidBlockCount, feedScrollModeAfterScroll, finishTaskRun, nextRunnablePrompt, summarizedFailureCount, visibleWorkspaceChangeCount } from '../renderer/src/task-runtime.ts'

test('swipe status always keeps a normally painted readable text layer', async () => {
  const [app, css, composerCss] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/composer-state.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /class="swipe-base"/)
  assert.match(app, /class="swipe-glint"/)
  assert.match(app, /<b class="thinking-label text-swipe">\s*<SwipeLayers text=\{status\.label\} \/>\s*<\/b>/)
  assert.match(css, /\.swipe-base\{[^}]*color:inherit/)
  assert.match(css, /\.thinking\{[^}]*display:flex;align-items:center;[^}]*padding:4px 0;[^}]*line-height:20px/)
  assert.match(css, /\.thinking \.thinking-label\{[^}]*font-size:12\.5px;[^}]*font-weight:480/)
  assert.doesNotMatch(css, /\.thinking\{[^}]*padding-left:/)
  assert.match(css, /\.swipe-layers\{[^}]*display:inline-grid;[^}]*margin:0;/)
  assert.match(css, /\.swipe-layers>span\{[^}]*grid-area:1\/1;[^}]*margin:0;/)
  assert.doesNotMatch(css, /\.thinking \.swipe-layers/)
  assert.doesNotMatch(composerCss, /\.thinking span\{/)
  assert.match(composerCss, /\.thinking>span\{/)
  assert.match(css, /0%,12%\{opacity:0;clip-path:/)
  assert.match(css, /88%,100%\{opacity:0;clip-path:/)
  assert.doesNotMatch(css, /\.text-swipe\{[^}]*color:transparent/)
  assert.doesNotMatch(css, /-webkit-text-fill-color:transparent/)
})

test('sidebar footer replaces the running version with update status beside settings', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /class="sidebar-version"/)
  assert.match(app, /v\{appUpdate\.currentVersion\}/)
  assert.match(app, /\{showUpdate \? \(\s*<button\s+class=\{`sidebar-update/)
  assert.match(css, /\.sidebar \.sidebar-footer\{[^}]*grid-template-columns:minmax\(0,1fr\) auto;[^}]*align-items:center/)
  assert.doesNotMatch(css, /sidebar-footer:has\(\.sidebar-update\)/)
  assert.match(css, /\.sidebar-settings svg\{[^}]*flex:0 0 15px/)
})

test('standalone recent tasks use top-level sidebar alignment', async () => {
  const css = await readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')

  assert.match(css, /\.workspace-tasks \.task\{[^}]*padding:0 9px 0 29px/)
  assert.match(css, /\.workspace-group\.loose \.workspace-tasks \.task\{padding-left:9px\}/)
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

  assert.doesNotMatch(app, /Connected ·|Not connected|已连接 ·|未连接/)
  assert.doesNotMatch(app, /class=\{models\.length \? "online"/)
  assert.doesNotMatch(panel, /\{models\.length\}/)
  assert.match(panel, /class="provider-editor-heading"/)
  assert.match(panel, /class="provider-models-columns"/)
  assert.match(panel, /!active \? providerSetup\(\) : <div class="provider-layout">/)
  assert.match(panel, /addingProvider \? providerSetup\(true\) : <div class="provider-editor">/)
  assert.match(panel, /class=\{`test-deployment/)
  assert.match(app, /window\.shun\.testModel\(active\.endpoint, active\.apiKey, model\.id\)/)
  assert.doesNotMatch(panel, /class=\{`test-deployment[^>]*\stitle=/)
  assert.match(panel, /t\("Testing", "测试中"\)/)
  assert.match(panel, /class="deployment-spinner"/)
  assert.match(app, /Promise\.race\(\[window\.shun\.testModel/)
  assert.match(app, /catch \(error\)/)
  assert.match(css, /\.settings-modal \.test-deployment\{[^}]*width:62px;[^}]*display:flex/)
  assert.match(css, /\.settings-modal \.test-deployment \.deployment-spinner\{[^}]*animation:deployment-spin/)
  assert.match(css, /Providers are edited as one connection followed by one flat deployment table\./)
  assert.match(css, /\.settings-modal \.provider-model-row\{[^}]*border-radius:0;[^}]*background:transparent/)
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
  assert.match(css, /\.toast-viewport\{[^}]*position:fixed;[^}]*z-index:240;[^}]*left:50%;[^}]*transform:translateX\(-50%\)/)
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
    readFile(new URL('./pi-runtime.ts', import.meta.url), 'utf8'),
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
  const css = await readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')

  assert.match(css, /\.user \.body\{border-color:var\(--composer-border\);background:var\(--composer-bg\)/)
  assert.match(css, /\.feed article\.user\{margin-bottom:40px\}/)
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

test('finishing one run preserves every other task run', () => {
  const active = { 'task-a': 'run-a', 'task-b': 'run-b' }
  assert.deepEqual(finishTaskRun(active, 'run-a'), { 'task-b': 'run-b' })
  assert.strictEqual(finishTaskRun(active, 'unknown'), active)
})

test('workspace change counts never leak into standalone drafts', () => {
  assert.equal(visibleWorkspaceChangeCount(undefined, 22, 8), 0)
  assert.equal(visibleWorkspaceChangeCount('', 22, 8), 0)
  assert.equal(visibleWorkspaceChangeCount('/project', 22, 8), 22)
  assert.equal(visibleWorkspaceChangeCount('/project', undefined, 8), 8)
})

test('streaming keeps the submitted turn locked until the user returns to the bottom', () => {
  assert.equal(feedScrollModeAfterScroll('locked-turn', true, true), 'locked-turn')
  assert.equal(feedScrollModeAfterScroll('locked-turn', false, false), 'free')
  assert.equal(feedScrollModeAfterScroll('free', true, false), 'follow-bottom')
})

test('group summaries disclose failures only when every action failed', () => {
  assert.equal(summarizedFailureCount(2, 3), 0)
  assert.equal(summarizedFailureCount(2, 2), 2)
  assert.equal(summarizedFailureCount(0, 0), 0)
})

test('closed Mermaid blocks render before the rest of a response finishes streaming', () => {
  assert.equal(completedMermaidBlockCount('```mermaid\ngraph TD\n  A-->B\n```\nMore text is streaming'), 1)
  assert.equal(completedMermaidBlockCount('```mermaid\ngraph TD\n  A-->B'), 0)
  assert.equal(completedMermaidBlockCount('~~~mermaid\nsequenceDiagram\n  A->>B: Hi\n~~~'), 1)
  assert.equal(completedMermaidBlockCount('```ts\nconst value = 1\n```\n```mermaid\ngraph LR\n  A-->B\n```'), 1)
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
