import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  applyRemoteEvent, applyRemoteEvents, applyRemoteHistory, applyRemoteSnapshot, catchUpContinues, emptyRemoteTaskView,
  remoteToolDetail, remoteToolTitle,
  type RemoteEvent, type RemoteSnapshot, type RemoteTool,
} from '../renderer/src/remote-conversation.ts'

function snapshot(overrides: Partial<RemoteSnapshot> = {}): RemoteSnapshot {
  return {
    taskId: 'task_1',
    latestSeq: 10,
    status: 'running',
    title: 'Remote task',
    workspace: '/tmp/work',
    turns: [{ id: 'run_1', role: 'assistant', content: 'Hello', timeline: [{ type: 'text', id: 'run_1-text-0', text: 'Hello' }] }],
    ...overrides,
  }
}

function event(seq: number, type: string, payload: Record<string, unknown> = {}): RemoteEvent {
  return { seq, taskId: 'task_1', timestamp: 1_000 + seq, type, payload }
}

function tool(state: RemoteTool['state'], output = ''): RemoteTool {
  return {
    id: 'tool_1',
    name: 'bash',
    state,
    presentation: { key: 'tool.command.done', args: {}, fallbackTitle: 'Peer wording', semanticIcon: 'terminal' },
    summary: 'npm test',
    output,
  }
}

test('a delta continues the turn it belongs to, and a duplicate sequence changes nothing', () => {
  const ready = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot())
  const appended = applyRemoteEvent(ready, event(11, 'turn.delta', { turnId: 'run_1', delta: ' world' }))
  assert.equal(appended.turns[0].content, 'Hello world')
  assert.deepEqual(appended.turns[0].timeline, [{ type: 'text', id: 'run_1-text-0', text: 'Hello world' }])
  assert.equal(appended.latestSeq, 11)

  const duplicate = applyRemoteEvent(appended, event(11, 'turn.delta', { turnId: 'run_1', delta: ' again' }))
  assert.equal(duplicate, appended)
  const outOfOrder = applyRemoteEvent(appended, event(9, 'turn.delta', { turnId: 'run_1', delta: ' earlier' }))
  assert.equal(outOfOrder, appended)
})

test('a tool reported running and then settled is one row, not two', () => {
  const ready = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot({ turns: [{ id: 'run_1', role: 'assistant', content: '', timeline: [] }] }))
  const running = applyRemoteEvent(ready, event(11, 'turn.entry', { turnId: 'run_1', entry: { type: 'tool', id: 'tool_1', tool: tool('running') } }))
  const settled = applyRemoteEvent(running, event(12, 'turn.entry', { turnId: 'run_1', entry: { type: 'tool', id: 'tool_1', tool: tool('done', '3 passed') } }))
  assert.equal(settled.turns[0].timeline.length, 1)
  const [entry] = settled.turns[0].timeline
  assert.equal(entry.type, 'tool')
  assert.equal(entry.type === 'tool' ? entry.tool.state : '', 'done')
  assert.equal(entry.type === 'tool' ? entry.tool.output : '', '3 passed')
})

test('a gap pauses application until the view has the events it missed', () => {
  const ready = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot())
  const jumped = applyRemoteEvent(ready, event(13, 'turn.delta', { turnId: 'run_1', delta: ' far ahead' }))
  assert.equal(jumped.needsResync, true)
  assert.equal(jumped.turns[0].content, 'Hello')
  assert.equal(jumped.latestSeq, 10)

  // Everything is refused while the hole is open, including the event that follows it.
  const refused = applyRemoteEvents(jumped, [event(13, 'turn.delta', { turnId: 'run_1', delta: ' far ahead' }), event(14, 'run.finished', { runId: 'run_1' })])
  assert.equal(refused.turns[0].content, 'Hello')
  assert.equal(refused.status, 'running')

  // A page that starts at the next expected sequence closes the gap.
  assert.equal(catchUpContinues(jumped, [event(11, 'turn.delta', { turnId: 'run_1', delta: ' one' })]), true)
  const caughtUp = applyRemoteEvents(jumped, [event(11, 'turn.delta', { turnId: 'run_1', delta: ' one' }), event(12, 'turn.delta', { turnId: 'run_1', delta: ' two' })])
  assert.equal(caughtUp.needsResync, false)
  assert.equal(caughtUp.latestSeq, 12)
  assert.equal(caughtUp.turns[0].content, 'Hello one two')

  // A page that starts later cannot close it: only a snapshot can.
  assert.equal(catchUpContinues(jumped, [event(13, 'turn.delta', { turnId: 'run_1', delta: ' far ahead' })]), false)
  const recovered = applyRemoteSnapshot(jumped, snapshot({ latestSeq: 20, turns: [{ id: 'run_1', role: 'assistant', content: 'Authoritative', timeline: [{ type: 'text', id: 'run_1-text-0', text: 'Authoritative' }] }] }))
  assert.equal(recovered.needsResync, false)
  assert.equal(recovered.latestSeq, 20)
  assert.equal(recovered.turns[0].content, 'Authoritative')
})

test('a run that started and finished on the other Shun becomes one user turn and one assistant turn', () => {
  const empty = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot({ status: 'idle', turns: [], latestSeq: 3 }))
  const started = applyRemoteEvent(empty, event(4, 'run.started', { runId: 'run_2', messageId: 'msg_2', text: 'Fix the failing test', startedAt: 1_004 }))
  assert.equal(started.status, 'running')
  assert.deepEqual(started.turns.map((turn) => [turn.id, turn.role]), [['msg_2', 'user'], ['run_2', 'assistant']])

  const failed = applyRemoteEvent(started, event(5, 'run.finished', { runId: 'run_2', status: 'error', error: 'The model refused.', completedAt: 1_005 }))
  assert.equal(failed.status, 'error')
  assert.equal(failed.turns[1].role, 'error')
  assert.equal(failed.turns[1].error, true)
  assert.match(failed.turns[1].content, /Error: The model refused\./)
  assert.equal(failed.turns[0].role, 'user')
})

test('approvals, queue, and a renamed task all land on the view', () => {
  let view = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot({ status: 'idle' }))
  view = applyRemoteEvent(view, event(11, 'approval.request', { approvalId: 'a1', title: 'Write outside the workspace', description: 'The task asked for a path in your home folder.', risk: 'This changes a file outside the workspace.' }))
  view = applyRemoteEvent(view, event(12, 'queue.snapshot', { items: [{ id: 'q1', taskId: 'task_1', text: 'then run the linter' }] }))
  view = applyRemoteEvent(view, event(13, 'task.patch', { title: 'Renamed remotely' }))
  assert.equal(view.approvals[0].state, 'pending')
  assert.equal(view.queue[0].text, 'then run the linter')
  assert.equal(view.title, 'Renamed remotely')

  view = applyRemoteEvent(view, event(14, 'approval.resolved', { approvalId: 'a1', decision: 'deny' }))
  assert.equal(view.approvals[0].state, 'denied')
})

test('earlier turns are prepended without duplicating what is already shown', () => {
  const ready = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot({
    turns: [{ id: 'run_2', role: 'assistant', content: 'Second', timeline: [] }],
    history: { hasMore: true, cursor: 'run_2' },
  }))
  assert.equal(ready.hasMoreHistory, true)

  const earlier = applyRemoteHistory(ready, {
    turns: [{ id: 'run_1', role: 'assistant', content: 'First', timeline: [] }, { id: 'run_2', role: 'assistant', content: 'Second', timeline: [] }],
    history: { hasMore: false, cursor: undefined },
  })
  assert.deepEqual(earlier.turns.map((turn) => turn.id), ['run_1', 'run_2'])
  assert.equal(earlier.hasMoreHistory, false)
})

test('a remote tool row names what happened in the reader\u2019s language, and falls back to the peer\u2019s wording', () => {
  const running = tool('running')
  assert.equal(remoteToolTitle(running, true), '正在执行命令')
  assert.equal(remoteToolTitle(running, false), 'Running command')
  assert.equal(remoteToolTitle(tool('error'), true), '命令失败')
  assert.equal(remoteToolDetail(running), 'npm test')

  const unknown: RemoteTool = { ...running, name: 'plugin_view_present', presentation: { ...running.presentation, key: 'tool.plugin_view_present' } }
  assert.equal(remoteToolTitle(unknown, true), 'Peer wording')
})

test('the console drives the remote command surface and resyncs by catch-up before snapshot', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const console = app.slice(app.indexOf('function RemoteConsole('), app.indexOf('function remoteStatusLabel('))

  assert.match(console, /command\("task\.message\.send", \{ taskId: target\.taskId, text, attachments: \[\] \}/)
  assert.match(console, /command\("task\.run\.cancel"/)
  assert.match(console, /task\.approval\.resolve/)
  assert.match(console, /command\("task\.queue\.sendNow"/)
  assert.match(console, /command\("task\.queue\.remove"/)
  assert.match(console, /"task\.create"/)
  assert.match(console, /"task\.history"/)
  assert.match(console, /"task\.events", \{ taskId: target\.taskId, afterSeq: next\.latestSeq \}/)
  assert.match(console, /if \(!catchUpContinues\(next, events\)\)/)
  assert.match(console, /"task\.snapshot", \{ taskId: target\.taskId, turnLimit: 40 \}/)
  assert.match(console, /window\.shun\.onRemoteDesktopEvent\(applyBatch\)/)
  assert.match(console, /if \(event\.resumed && target\?\.desktopId === event\.id\) void resync\(target\)/)
  assert.match(console, /window\.shun\.pairRemoteDesktop\(code\)/)
  assert.match(console, /window\.shun\.unpairRemoteDesktop\(id\)/)
  assert.match(console, /window\.shun\.wakeRemoteDesktops\(\)/)
  assert.match(console, /if \(!current\?\.ready\) \{\n\s+buffered\.current\.push\(\.\.\.events\)/)
})

test('the console opens one tool in full, and the peer answers with the whole record', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const consoleSource = app.slice(app.indexOf('function RemoteConsole('), app.indexOf('function remoteStatusLabel('))
  const hostHandler = app.slice(app.indexOf("if (request.kind === 'task.tool')"), app.indexOf("if (request.kind === 'task.rename')"))

  assert.match(consoleSource, /window\.shun\.requestRemoteDesktop\(target\.desktopId, "task\.tool", \{ taskId: target\.taskId, toolId \}\)/)
  assert.match(consoleSource, /if \(next && !records\[next\]\) void loadToolRecord\(next\)/)
  assert.match(consoleSource, /record=\{records\[entry\.id\]\}/)
  assert.match(hostHandler, /const tool = target\.turns\.flatMap\(turnTools\)\.find\(item => item\.id === toolId\)/)
  assert.match(hostHandler, /return remoteToolRecord\(tool\)/)
})

test('the console can read the remote changes, processes, and folders it drives', async () => {
  const [app, main] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
  ])
  const consoleSource = app.slice(app.indexOf('function RemoteConsole('), app.indexOf('function remoteStatusLabel('))

  assert.match(consoleSource, /"repository\.snapshot"/)
  assert.match(consoleSource, /"repository\.diff"/)
  assert.match(consoleSource, /changeDiffFor\(changes, entry\.path\)/)
  assert.match(consoleSource, /saveFile\(entry\.path\)/)
  assert.match(consoleSource, /"resources\.list"/)
  assert.match(consoleSource, /command\("resource\.stop", \{ taskId: open\.taskId, id: item\.id \}\)/)
  assert.match(consoleSource, /"workspaces\.browse"/)
  assert.match(consoleSource, /setWorkspace\(browsing\.path\)/)
  assert.match(consoleSource, /\.\.\.\(workspace \? \{ workspace \} : \{\}\)/)

  const save = main.slice(main.indexOf("ipcMain.handle('remote-client:save'"), main.indexOf("ipcMain.handle('remote-client:wake')"))
  assert.match(save, /client\.request\(String\(desktopId\), 'file\.download\.info'/)
  assert.match(save, /dialog\.showSaveDialog\(win!, \{ defaultPath: remoteDownloadName\(info\) \}\)/)
  assert.match(save, /return \{ saved: false as const \}/)
  assert.match(save, /saveRemoteFile\(\{/)
})

test('a terminal belongs to the controller that opened it, and to the task it runs in', async () => {
  const [main, service, panel] = await Promise.all([
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('./remote-service.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-terminal-panel.tsx', import.meta.url), 'utf8'),
  ])

  const handler = main.slice(main.indexOf("if (frame.kind === 'terminal.open'"), main.indexOf("if (frame.kind === 'attachment.upload.begin')"))
  assert.match(handler, /remoteTerminals\.open\(\{ linkId, taskId, workspace, cols: payload\.cols, rows: payload\.rows \}\)/)
  assert.match(handler, /remoteTerminals\.write\(terminalId, payload\.data\)/)
  assert.match(handler, /remoteTerminals\.resize\(terminalId, payload\.cols, payload\.rows\)/)
  assert.match(handler, /remoteTerminals\.close\(terminalId\)/)
  assert.match(main, /const workspace = await taskWorkspacePath\(taskId\)/)
  assert.match(main, /onLinkClosed: linkId => remoteTerminals\?\.closeLink\(linkId\)/)
  assert.match(main, /remoteRelay\?\.pushToLink\(linkId, event\)/)
  assert.match(service, /async pushToLink\(linkId: string, event: unknown\)/)
  assert.match(service, /this\.#options\.request\(request, link\.id\)/)

  assert.match(panel, /request\('terminal\.open', \{ taskId, cols: instance\.cols, rows: instance\.rows \}\)/)
  assert.match(panel, /request\('terminal\.write', \{ terminalId: liveTerminal\.current, data \}\)/)
  assert.match(panel, /request\('terminal\.resize', \{ terminalId: liveTerminal\.current, cols: instance\.cols, rows: instance\.rows \}\)/)
  assert.match(panel, /request\('terminal\.close', \{ terminalId: session \}\)/)
  assert.match(panel, /window\.shun\.onRemoteDesktopTerminal\(\(frame\) => \{/)
  assert.match(panel, /if \(frame\.desktopId !== desktopId \|\| frame\.taskId !== taskId\) return/)
})

test('the console reaches the remote workspace, files, and terminal', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const consoleSource = app.slice(app.indexOf('function RemoteConsole('), app.indexOf('function remoteStatusLabel('))

  assert.match(consoleSource, /"files\.browse"/)
  assert.match(consoleSource, /loadFiles\(entry\.path\)/)
  assert.match(consoleSource, /saveFile\(entry\.path\)/)
  assert.match(consoleSource, /<SquareTerminal \/>\{zh \? "终端" : "Terminal"\}/)
  assert.match(consoleSource, /disabled=\{!openDesktop\?\.connected\}/)
  assert.match(consoleSource, /<RemoteTerminalPanel/)
  const hostHandler = app.slice(app.indexOf("if (request.kind === 'files.browse')"), app.indexOf("if (request.kind === 'task.events')"))
  assert.match(hostHandler, /window\.shun\.listWorkspaceFiles\(target\.workspace, requested\)/)
})

test('the sidebar reaches the remote console and leaves the local task surface', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const css = await readFile(new URL('../renderer/src/remote-console.css', import.meta.url), 'utf8')
  const index = await readFile(new URL('../renderer/src/index.tsx', import.meta.url), 'utf8')

  assert.match(app, /<Monitor \/>\n\s+<span>\{zh \? "远端 Shun" : "Remote Shuns"\}<\/span>/)
  assert.match(app, /\) : showRemote \? \(\n\s+<RemoteConsole/)
  assert.match(app, /const taskSurfaceVisible = [^\n]*!showRemote/)
  assert.match(index, /import '\.\/remote-console\.css'/)
  // Every class the console renders has an owner: an unstyled pane would still
  // "work" while looking broken, and nothing else would report it.
  for (const name of ['remote-console', 'remote-toolbar', 'remote-side', 'remote-desktop', 'remote-task', 'remote-feed', 'remote-tool-row', 'remote-approval', 'remote-queue', 'remote-composer', 'remote-pair', 'remote-stage', 'remote-drawer', 'remote-change', 'remote-diff', 'remote-workspace', 'remote-browse']) {
    assert.match(css, new RegExp(`\\.${name}[{,.:\\s]`), `missing styles for .${name}`)
  }
})
