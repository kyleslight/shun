import assert from 'node:assert/strict'
import test from 'node:test'
import { completedMermaidBlockCount, feedScrollModeAfterScroll, finishTaskRun, nextRunnablePrompt, summarizedFailureCount, visibleWorkspaceChangeCount } from '../renderer/src/task-runtime.ts'
import { buildExcalidrawFlowSkeleton, stableExcalidrawSeed } from '../renderer/src/mermaid/excalidraw-flow-model.ts'

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
