import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { buildExcalidrawFlowSkeleton, stableExcalidrawSeed } from '../renderer/src/mermaid/excalidraw-flow-model.ts'
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

test('sidebar footer shows the running application version beside settings', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])

  assert.match(app, /class="sidebar-version"/)
  assert.match(app, /v\{appUpdate\.currentVersion\}/)
  assert.match(css, /\.sidebar \.sidebar-footer\{[^}]*grid-template-columns:minmax\(0,1fr\) auto;[^}]*align-items:center/)
  assert.match(css, /\.sidebar-settings svg\{[^}]*flex:0 0 15px/)
})

test('standalone recent tasks use top-level sidebar alignment', async () => {
  const css = await readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8')

  assert.match(css, /\.workspace-tasks \.task\{[^}]*padding:0 9px 0 29px/)
  assert.match(css, /\.workspace-group\.loose \.workspace-tasks \.task\{padding-left:9px\}/)
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
