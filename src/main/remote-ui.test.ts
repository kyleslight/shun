import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { remoteTaskSnapshot } from '../remote-projection.ts'
import {
  applyRemoteEvent, applyRemoteEvents, applyRemoteHistory, applyRemoteSnapshot, catchUpContinues, emptyRemoteTaskView,
  remoteRunningTurnId, remoteToolDetail, remoteToolTitle, remoteTurnsAsLocal,
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
  const session = await readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8')
  const console = session + app.slice(app.indexOf('function RemotePanels('), app.indexOf('function PairingDialog('))

  assert.match(session, /command\("task\.message\.send", \{ taskId: target\.taskId, text, messageId, runId, attachments: attachments\.map\(\(item\) => \(\{ id: item\.id \}\)\) \}/)
  assert.match(app, /remote\.command\("task\.run\.cancel"/)
  assert.match(app, /remote\.command\("task\.approval\.resolve"/)
  assert.match(app, /remote\.command\("task\.queue\.sendNow"/)
  assert.match(app, /remote\.command\("task\.queue\.remove"/)
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
  const session = await readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8')
  const consoleSource = session + app.slice(app.indexOf('function RemotePanels('), app.indexOf('function PairingDialog('))
  const hostHandler = app.slice(app.indexOf("if (request.kind === 'task.tool')"), app.indexOf("if (request.kind === 'task.rename')"))

  assert.match(consoleSource, /window\.shun\.requestRemoteDesktop\(target\.desktopId, "task\.tool", \{ taskId: target\.taskId, toolId \}\)/)
  // The row the app already draws asks for the whole record when it opens.
  assert.match(app, /onExpandTool=\{showRemote \? \(toolId: string\) => void remote\.loadToolRecord\(toolId\) : undefined\}/)
  assert.match(app, /if \(next\) onExpand\?\.\(tool\.id\)/)
  assert.match(app, /remoteTurnsAsLocal\(remote\.view, remote\.records\)/)
  assert.match(hostHandler, /const tool = target\.turns\.flatMap\(turnTools\)\.find\(item => item\.id === toolId\)/)
  assert.match(hostHandler, /return remoteToolRecord\(tool\)/)
})

test('the console can read the remote changes, processes, and folders it drives', async () => {
  const [app, main] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
  ])
  const session = await readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8')
  const consoleSource = session + app.slice(app.indexOf('function RemotePanels('), app.indexOf('function PairingDialog('))

  assert.match(session, /"repository\.snapshot"/)
  assert.match(session, /"repository\.diff"/)
  assert.match(consoleSource, /changeDiffFor\(changes, entry\.path\)/)
  assert.match(consoleSource, /attach\(entry\.path\)/)
  assert.match(consoleSource, /"resources\.list"/)
  assert.match(consoleSource, /command\("resource\.stop", \{ taskId: open\.taskId, id: item\.id \}\)/)
  assert.match(consoleSource, /"workspaces\.browse"/)
  assert.match(consoleSource, /chooseWorkspace\(browsing\.path\)/)
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

test('the remote mode reaches the workspace, the files, and the terminal', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const session = await readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8')
  const panels = app.slice(app.indexOf('function RemotePanels('), app.indexOf('function PairingDialog('))

  assert.match(session, /"files\.browse"/)
  assert.match(panels, /loadFiles\(entry\.path\)/)
  assert.match(panels, /attach\(entry\.path\)/)
  assert.match(panels, /<RemoteTerminalPanel/)
  // The panels open from the header's utility cluster — the place this app keeps
  // a task's own controls — as icons with their labels in the usual attributes.
  assert.match(app, /<span class="header-utility-pair remote-utility-pair">/)
  assert.match(app, /aria-label=\{zh \? "终端" : "Terminal"\}/)
  assert.match(app, /disabled=\{!remote\.active\?\.connected\}/)
  // A control row carries controls, not prose: the machine is named on its own row.
  assert.doesNotMatch(app, /remote-run-note/)
  const hostHandler = app.slice(app.indexOf("if (request.kind === 'files.browse')"), app.indexOf("if (request.kind === 'task.events')"))
  assert.match(hostHandler, /window\.shun\.listWorkspaceFiles\(target\.workspace, requested, payload\.includeHidden === true\)/)
})

test('the console leaves the macOS window buttons their room, and closes up without them', async () => {
  const [css, refine] = await Promise.all([
    readFile(new URL('../renderer/src/remote-console.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])
  // One place knows whether three window buttons sit over this corner: macOS
  // says 84/130, Windows and Linux say 19/60, and fullscreen takes them away.
  assert.match(refine, /:root\[data-platform="mac"\]\{--sidebar-toggle-left:84px;--sidebar-title-gutter:130px\}/)
  assert.match(refine, /:root\[data-platform="mac"\] \.window-fullscreen\{--sidebar-toggle-left:19px\}/)
  assert.match(css, /\.sidebar-collapsed \.remote-toolbar\{padding-left:var\(--sidebar-title-gutter\)\}/)
  // Fullscreen takes the buttons away without changing the platform variable, so
  // the app overrides this case by name, and so does the console.
  assert.match(refine, /\.window-fullscreen\.sidebar-collapsed \.stage>header\{padding-left:60px\}/)
  assert.match(css, /\.window-fullscreen\.sidebar-collapsed \.remote-toolbar\{padding-left:60px\}/)
  assert.match(css, /@media\(max-width:760px\)\{\.remote-toolbar\{padding-left:var\(--sidebar-title-gutter\)\}\}/)
  // A hard-coded left inset would only be right on one of those platforms. The
  // one exception is fullscreen, which the app also writes by name.
  const insets = css.split('\n').filter(line => line.includes('.remote-toolbar{') && line.includes('padding-left'))
  assert.deepEqual(insets.map(line => line.slice(0, line.indexOf('.remote-toolbar{'))), [
    '.sidebar-collapsed ',
    '.window-fullscreen.sidebar-collapsed ',
    '@media(max-width:760px){',
  ])
  // Two of the three read the platform that actually has the buttons.
  assert.equal(insets.filter(line => line.includes('var(--sidebar-title-gutter)')).length, 2)
})

test('the sidebar reaches the remote console and leaves the local task surface', async () => {
  const [app, css, index, terminalCss, panel] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-console.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/index.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/terminal-panel.css', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-terminal-panel.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(app, /\{showRemote \? <ArrowLeft \/> : <Monitor \/>\}\n\s+<span>\{showRemote \? \(zh \? "返回任务" : "Back to tasks"\)/)
  // Remote renders the app's own surface: the same list feeds the sidebar, the
  // same feed draws its turns, and the panels only add what has no local twin.
  assert.match(app, /remoteSidebarTasks = showRemote \? \(remote\.tasks\[remote\.active\?\.id \|\| ""\] \|\| \[\]\) : \[\]/)
  assert.match(app, /feedTurns = showRemote \? remoteTurnsAsLocal\(remote\.view, remote\.records\) : turns/)
  assert.match(app, /showRemote && <RemotePanels session=\{remote\} language=\{uiLanguage\} notify=\{notify\} \/>/)
  assert.match(app, /const taskSurfaceVisible = [^\n]*!showRemote/)
  assert.match(index, /import '\.\/remote-console\.css'/)
  // Every class the console renders has an owner: an unstyled pane would still
  // "work" while looking broken, and nothing else would report it.
  for (const name of ['remote-console', 'remote-toolbar', 'remote-side', 'remote-desktop', 'remote-task', 'remote-stage', 'remote-feed', 'remote-drawer', 'remote-change', 'remote-files', 'remote-workspace', 'remote-browse', 'remote-approval', 'remote-queue', 'remote-pair-dialog', 'remote-pair-code']) {
    assert.match(css, new RegExp(`\\.${name}[{,.:\\s]`), `missing styles for .${name}`)
  }
  // The remote terminal is the app's own bottom panel, not a lookalike: one
  // chrome, one canvas sizing, one resizer.
  assert.match(panel, /class=\{`terminal-panel\$\{maximized \? ' is-maximized' : ''\}`\}/)
  assert.match(panel, /class="terminal-canvas"/)
  assert.match(panel, /class="terminal-panel-title"/)
  assert.match(terminalCss, /\.terminal-panel\{position:absolute/)
})

test('a remote task action reaches the machine that owns the task', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  const host = app.slice(app.indexOf("if (request.kind === 'task.archive'"), app.indexOf("if (request.kind === 'task.delete'"))

  // Archiving and deleting a row the peer owns must never run the local paths:
  // they would act on a local task that happens to share that id.
  assert.match(app, /if \(showRemote\) \{\n\s+void remoteTaskAction\(archived \? "task\.archive" : "task\.restore", id\)/)
  assert.match(app, /if \(showRemote\) \{\n\s+const item = remoteSidebarTasks\.find/)
  assert.match(app, /void remoteTaskAction\("task\.delete", id\)/)
  assert.match(app, /void remoteTaskAction\("task\.rename", target\.id, \{ title: title\.slice\(0, 120\) \}\)/)
  assert.match(host, /request\.kind === 'task\.archive' \|\| request\.kind === 'task\.restore'/)
  assert.match(host, /archiveTask\(taskId, archived\)/)
})

test('a remote conversation keeps up with the run instead of stopping at its snapshot', async () => {
  const [session, css] = await Promise.all([
    readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-console.css', import.meta.url), 'utf8'),
  ])

  // A view that skipped a sequence refuses everything after it. Nothing else
  // would notice, so the surface that drew it has to ask for what it missed —
  // otherwise a conversation stops on whatever its snapshot said, and a run
  // that finished still reads as running.
  assert.match(session, /const next = applyRemoteEvents\(current, events\);\n\s+setView\(next\);/)
  assert.match(session, /if \(next\.needsResync\) void resync\(target\);/)
  // A row's state follows the run, so the list updates when one starts or ends.
  assert.match(session, /event\.type === "run\.started" \|\| event\.type === "run\.finished" \|\| event\.type === "task\.patch"/)
  // And a run that is going is checked on a short clock, so a push lost in
  // flight cannot leave the view idle while the peer works.
  assert.match(session, /export const REMOTE_LIVE_RECOVERY_MS = 10_000/)
  // The clock runs for any open conversation, on the peer's own statement that it
  // is working — a view that wrongly reads as idle is the one that never asks.
  assert.match(session, /if \(!open\) return;/)
  assert.match(session, /const peerIsWorking = \(tasksRef\.current\[target\.desktopId\] \|\| \[\]\)\.some/)
  assert.match(session, /if \(peerIsWorking \|\| viewIsRunning\) void refreshFromSnapshot\(target\);/)
  assert.match(session, /\}, REMOTE_LIVE_RECOVERY_MS\);/)
  assert.match(session, /void loadTasks\(target\.desktopId, true\);/)
  // And the message appears before the other machine has answered for it.
  assert.match(session, /appendOptimisticTurn\(current, \{ messageId, text, attachments \}\)/)
  assert.match(session, /removeOptimisticTurn\(current, messageId\)/)


  // A device name is long and a link state is short: the row lays them out
  // itself rather than letting a floating label land on the name.
  assert.match(css, /\.remote-device\{display:grid;grid-template-columns:8px minmax\(0,1fr\) 22px/)
  assert.doesNotMatch(css, /\.remote-device small\{position:absolute/)
})

test('switching to a remote task shows what it is waiting for, and names that task', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-console.css', import.meta.url), 'utf8'),
  ])

  // A task with content is not an empty task: until the conversation lands the
  // feed shows a skeleton, not an invitation to start writing.
  assert.match(app, /showRemote && !!remote\.open && !remote\.view\?\.ready && \(/)
  assert.match(app, /remote-skeleton-line/)
  assert.match(app, /\{!feedTurns\.length && !showRemote && \(/)
  // And the template names the machine's own workspace, never this machine's
  // "choose a project" placeholder.
  assert.match(app, /我们要在 <span>\{feedWorkspace\}<\/span> 中构建什么？/)
  assert.doesNotMatch(app, /要构建什么？[\s\S]{0,40}<span>\{workspace\}<\/span>/)
  assert.match(css, /\.remote-skeleton-line\{/)
})

test('a remote conversation keeps arriving: pushes, a snapshot net, and being followed', async () => {
  const [session, app, css] = await Promise.all([
    readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-console.css', import.meta.url), 'utf8'),
  ])

  // The recovery net is a snapshot rather than a page of events: it carries the
  // run's state and the conversation in one answer, so it cannot come back
  // "nothing new" while the view is wrong — which is how a finished run kept
  // reading as running and a streaming peer looked silent.
  assert.match(session, /void refreshFromSnapshot\(target\);/)
  assert.match(session, /async function refreshFromSnapshot\(/)
  assert.match(session, /const snapshot = await window\.shun\.requestRemoteDesktop\(target\.desktopId, "task\.snapshot"/)
  // A catch-up that cannot be read sends the view to the snapshot instead of
  // leaving it exactly as it was.
  assert.match(session, /\} catch \{\n\s+next = \{ \.\.\.next, needsResync: true \};\n\s+break;/)

  // Opening a conversation lands at its end, and output keeps it there while
  // the person is looking at the end.
  assert.match(app, /feedScrollMode\.current = "follow-bottom";/)
  assert.match(app, /feedIsNearEnd\(\{\n\s+scrollTop: node\.scrollTop,/)
  assert.match(app, /\}, \[showRemote, remote\.open\?\.taskId, remote\.view\?\.ready, remote\.view\?\.latestSeq, remote\.view\?\.turns\.length, remote\.view\?\.queue\.length\]\)/)

  // The composer is the same bar as any other conversation: the peer's own
  // context reading on the left, the one control that always applies on the right.
  assert.match(app, /remoteContext = showRemote \? remoteContextMeter\(remote\.view\) : undefined,/)
  assert.match(app, /<div class=\{`bar\$\{showRemote \? " remote-bar" : ""\}`\}>/)
  // The remote bar adds no placement of its own: the context reading already
  // carries the auto margin, and a second one on the send button splits the free
  // space — the meter and the model ended up floating mid-bar, which is not how
  // any other conversation's composer looks.
  assert.doesNotMatch(css, /\.remote-bar[^{]*\{[^}]*margin/)
})

test('a refresh merges into the conversation instead of replacing it', () => {
  const ready = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), {
    taskId: 'task_1',
    latestSeq: 10,
    status: 'running',
    title: 'Remote task',
    workspace: '/tmp/work',
    turns: [
      { id: 'run_1', role: 'assistant', content: 'Hello', timeline: [{ type: 'text', id: 'run_1-text-0', text: 'Hello' }] },
      { id: 'run_2', role: 'assistant', content: 'World', timeline: [{ type: 'text', id: 'run_2-text-0', text: 'World' }] },
    ],
  })

  // The same conversation arriving again must not look like a different one: a
  // replaced turn takes the feed's place with it, which is what made a stream
  // jump back to somewhere earlier.
  const same = applyRemoteSnapshot(ready, {
    taskId: 'task_1',
    latestSeq: 12,
    status: 'running',
    title: 'Remote task',
    workspace: '/tmp/work',
    turns: [
      { id: 'run_1', role: 'assistant', content: 'Hello', timeline: [{ type: 'text', id: 'run_1-text-0', text: 'Hello' }] },
      { id: 'run_2', role: 'assistant', content: 'World', timeline: [{ type: 'text', id: 'run_2-text-0', text: 'World' }] },
    ],
  })
  assert.equal(same.turns[0], ready.turns[0])
  assert.equal(same.turns[1], ready.turns[1])
  assert.equal(same.latestSeq, 12)

  // Only what really changed is taken from the refresh.
  const grown = applyRemoteSnapshot(same, {
    taskId: 'task_1',
    latestSeq: 14,
    status: 'running',
    title: 'Remote task',
    workspace: '/tmp/work',
    turns: [
      { id: 'run_1', role: 'assistant', content: 'Hello', timeline: [{ type: 'text', id: 'run_1-text-0', text: 'Hello' }] },
      { id: 'run_2', role: 'assistant', content: 'World and more', timeline: [{ type: 'text', id: 'run_2-text-0', text: 'World and more' }] },
      { id: 'run_3', role: 'assistant', content: 'Newest', timeline: [] },
    ],
  })
  assert.equal(grown.turns[0], ready.turns[0])
  assert.equal(grown.turns[1].content, 'World and more')
  assert.equal(grown.turns[2].id, 'run_3')

  // A snapshot older than what the view already applied never moves the cursor
  // backwards: those events would look new again and stall the ones after them.
  const stale = applyRemoteSnapshot(grown, {
    taskId: 'task_1',
    latestSeq: 9,
    status: 'running',
    title: 'Remote task',
    workspace: '/tmp/work',
    turns: [],
  })
  assert.equal(stale.latestSeq, 14)
  assert.deepEqual(stale.turns.map((turn) => turn.id), ['run_1', 'run_2', 'run_3'])
})

test('the plugin and skill panels open from wherever they are asked for', async () => {
  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')

  // Remote is a mode of the stage, so a surface reached from inside it has to
  // leave the mode: otherwise the panel is asked for and never appears.
  assert.match(app, /if \(showRemote && \(prompt === "\/plugins" \|\| prompt === "\/skills" \|\| prompt === "\/settings"\)\) \{/)
  assert.match(app, /setPluginSurface\(prompt === "\/skills" \? "skills" : "plugins"\);/)
  assert.match(app, /setShowRemote\(false\);\n\s+setSearching\(false\);/)
  // A deep link asks for the store over whatever is showing, Remote included.
  assert.match(app, /if \(!target\) return;\n\s+setShowRemote\(false\);/)
  // And the palette exists in Remote: `/` reads the draft the surface writes, and
  // a leading command is a command rather than a message to the other machine.
  assert.match(app, /composerDraft = showRemote \? remote\.draft : text,/)
  assert.match(app, /if \(prompt && executeSlashCommand\(prompt\)\) return;/)
  assert.match(app, /const remoteCommands = new Set\(\["plugins", "skills", "settings", "new", "archive", "compact"\]\)/)
})

test('a paired machine can be disconnected, and Remote can be left', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-console.css', import.meta.url), 'utf8'),
  ])

  // A paired machine is a row in this list, so it carries the row's own menu and
  // this app's confirmation for a destructive action — not a hover-only control
  // nobody can find.
  assert.match(app, /itemMenu === `device:\$\{desktop\.id\}` && taskMenuPosition && createPortal/)
  assert.match(app, /<Unlink \/>\n\s+\{zh \? "断开配对" : "Unpair"\}/)
  assert.match(app, /title: zh \? `断开与“\$\{desktop\.name\}”的配对？`/)
  assert.match(app, /action: \(\) => void remote\.unpair\(desktop\.id\),/)
  assert.match(css, /\.remote-device-actions\{opacity:1/)
  // Getting in is getting out: the entry toggles, the way the archived list does.
  assert.match(app, /setShowRemote\(\(current\) => !current\);/)
  assert.match(app, /\{showRemote \? <ArrowLeft \/> : <Monitor \/>\}/)
  assert.match(app, /\{showRemote \? \(zh \? "返回任务" : "Back to tasks"\) : \(zh \? "远端" : "Remote"\)\}/)
})

test('both directions are visible: what this Mac drives and what is paired to it', async () => {
  const [app, main, session] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8'),
  ])

  // The machines paired *to* this Mac are the other half of the same surface.
  // Nothing showed them, which is why a pairing that was there all along read as
  // lost — and a public key is not a name, so the controller sends one.
  assert.match(app, /\{remote\.pairedDevices\.map\(\(device\) => \(/)
  assert.match(app, /device\.name \|\| `#\$\{device\.id\.slice\(0, 8\)\}`/)
  assert.match(app, /action: \(\) => void remote\.forgetDevice\(device\.id, name\),/)
  assert.match(session, /const \[pairedDevices, setPairedDevices\] = useState<RemoteDeviceState\[\]>\(\[\]\);/)
  assert.match(main, /ipcMain\.handle\('remote:forget'/)

  // The list is read before the window that asks for it, and a state event for a
  // machine it has never listed reads it again rather than waiting.
  assert.match(main, /await remoteClient\.start\(\)[\s\S]{0,400}createWindow\(await storedWindowTheme\(\)\)/)
  assert.match(session, /if \(!known\) void refreshDesktops\(\);/)
})

test('the remote composer is the composer: attach, the peer\u2019s context, its models, send', async () => {
  const [app, session, main, refine] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8'),
    readFile(new URL('./index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/composer-state.css', import.meta.url), 'utf8'),
  ])

  // Same bar as any other conversation, and the same order: attach first, then
  // the meter (which this app pushes to the right), then the model, then send.
  const barStart = app.indexOf('class={`bar${showRemote ? " remote-bar"')
  const bar = app.slice(barStart, app.indexOf('</> : <>', barStart))
  assert.match(bar, /class="attach-file"[\s\S]*<ContextMeter[\s\S]*class="model-btn"[\s\S]*class="send"/)
  assert.match(refine, /\.context-meter-wrap\{position:relative;margin-left:auto\}/)
  assert.match(app, /remote\.attachFiles\(\)/)
  assert.match(app, /remote\.selectModel\(model\.id\)/)

  // The files travel through the process that owns them, not as bytes through
  // the renderer.
  assert.match(main, /ipcMain\.handle\('remote-client:attach'/)
  assert.match(main, /await uploadRemoteFile\(\{/)
  assert.match(session, /await window\.shun\.attachRemoteFiles\(target\.desktopId, target\.taskId\)/)
  assert.doesNotMatch(session, /base64url/)

  // And the model list is the machine's that runs the task.
  assert.match(session, /"models\.list"/)
  assert.match(session, /command\("task\.model", \{ taskId: target\.taskId, model \}\)/)
})

test('a context reading is a number for the meter, and only a compaction is a step in the flow', () => {
  const ready = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot())
  const reading = applyRemoteEvent(ready, event(11, 'turn.entry', {
    turnId: 'run_1',
    entry: { type: 'context', id: 'run_1-context', context: { state: 'ready', used: 62_000, total: 1_000_000 } },
  }))

  // The number reaches the meter the composer draws...
  assert.equal(reading.turns[0].context?.used, 62_000)
  // ...and the conversation is untouched: an ordinary measurement is not an
  // event in someone's reply, which is what drew "Context compacted" in the
  // middle of a run that had not compacted anything.
  assert.equal(reading.turns[0].timeline.length, 1)
  assert.deepEqual(remoteTurnsAsLocal(reading)[0].timeline, [{ type: 'text', text: 'Hello' }])
  assert.equal(remoteTurnsAsLocal(reading)[0].contextUsage, undefined)

  // A compaction is a step: it is placed where it happened...
  const compacting = applyRemoteEvent(reading, event(12, 'turn.entry', {
    turnId: 'run_1',
    entry: { type: 'context', id: 'run_1-context', context: { state: 'compacting', used: 62_000, total: 1_000_000 } },
  }))
  assert.equal(compacting.turns[0].timeline.at(-1)?.type, 'context')
  assert.equal(compacting.turns[0].context?.state, 'compacting')

  // ...and its end replaces the notice in place instead of adding a second one.
  const compacted = applyRemoteEvent(compacting, event(13, 'turn.entry', {
    turnId: 'run_1',
    entry: { type: 'context', id: 'run_1-context', context: { state: 'compacted', used: 12_000, total: 1_000_000 } },
  }))
  assert.equal(compacted.turns[0].timeline.length, 2)
  const notice = compacted.turns[0].timeline.at(-1)
  assert.ok(notice?.type === 'context')
  assert.equal(notice.context.state, 'compacted')

  const local = remoteTurnsAsLocal(compacted)[0]
  assert.equal(local.timeline.length, 2)
  const localNotice = local.timeline.at(-1)
  assert.ok(localNotice?.type === 'context')
  assert.equal(localNotice.context.state, 'compacted')
  assert.equal(local.contextUsage?.state, 'compacted')
})

test('a snapshot carries the compaction state it found, and the projection sends it', async () => {
  const [projection, conversation] = await Promise.all([
    readFile(new URL('../remote-projection.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-conversation.ts', import.meta.url), 'utf8'),
  ])

  // What a reading was taken for travels with it, live and in a snapshot; the
  // state is what lets the controller tell a measurement from a compaction.
  assert.match(projection, /state: event\.context\.state,/)
  assert.match(projection, /contextUsage: turn\.contextUsage \? \{\n\s+state: turn\.contextUsage\.state,/)
  assert.match(conversation, /function remoteTurnFromPayload\(turn: RemoteTurnPayload\): RemoteTurn \{/)
  assert.match(conversation, /contextUsage\?: RemoteContextReading \}/)

  // A peer that reports nothing but the compaction event still lands as one.
  const ready = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot({
    turns: [{ id: 'run_1', role: 'assistant', content: 'Hello', timeline: [], contextUsage: { state: 'compacted', used: 12_000, total: 1_000_000 } }],
  }))
  assert.equal(ready.turns[0].context?.state, 'compacted')
  assert.equal(remoteTurnsAsLocal(ready)[0].contextUsage?.state, 'compacted')
  const older = applyRemoteEvent(applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot({ turns: [{ id: 'run_1', role: 'assistant', content: 'Hello', timeline: [] }] })), event(11, 'turn.patch', { turnId: 'run_1', patch: { compacted: true } }))
  assert.equal(remoteTurnsAsLocal(older)[0].contextUsage?.state, 'compacted')
})

test('a message sent to the other machine leaves the composer at once and takes the feed with it', async () => {
  const [session, app] = await Promise.all([
    readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
  ])

  // The box empties and the message appears as it is sent, not after the other
  // machine has answered: a relay round trip between pressing Enter and the
  // sentence leaving the box is what made a sent message look unsent.
  const send = session.slice(session.indexOf('async function send()'), session.indexOf('async function startRemoteTask()'))
  assert.match(send, /setDraft\(""\);\n\s+setPendingAttachments\(\[\]\);\n\s+setSentTurnId\(messageId\);/)
  assert.ok(send.indexOf('setDraft("")') < send.indexOf('await command('))
  // A message the peer refuses comes back to the person who wrote it.
  assert.match(send, /setDraft\(\(current\) => current\.trim\(\) \? current : text\);/)
  assert.match(send, /setPendingAttachments\(\(current\) => current\.length \? current : restored\);/)
  assert.match(session, /const \[sentTurnId, setSentTurnId\] = useState\(""\);/)

  // ...and the feed goes where the message went, the way a local send leaves it.
  assert.match(app, /remoteFollowEnd\.current = true;\n\s+feedScrollMode\.current = "follow-stream";\n\s+pendingScrollTurn\.current = remote\.sentTurnId;/)
  assert.match(app, /const anchor = node\.querySelector<HTMLElement>\(`\[data-turn-id="\$\{CSS\.escape\(pending\)\}"\]`\);/)
  assert.match(app, /if \(feedRunning && feedScrollMode\.current === "follow-stream"\) \{\n\s+revealRunningTurn\(node, feedRunning\);/)
})

test('an image from the other machine opens in this app\u2019s own viewer', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-console.css', import.meta.url), 'utf8'),
  ])

  // A screenshot in a remote conversation is a picture, not a poster: it opens
  // full size in the same dialog a local attachment opens in.
  assert.match(app, /<button type="button" class="remote-shot-open" title=\{name\} aria-label=\{name\} onClick=\{\(\) => open\(desktopId, taskId, attachment\)\}>/)
  assert.match(app, /open=\{openRemoteAttachmentPreview\}/)
  assert.match(app, /async function openRemoteAttachmentPreview\(desktopId: string, taskId: string, attachment: RemoteAttachment\)/)
  assert.match(app, /remote: \{ desktopId, taskId, attachmentId: attachment\.id \},/)
  assert.match(css, /\.remote-shot-open\{[^}]*cursor:zoom-in/)

  // What acts on a local file is not offered for one that is not here.
  assert.match(app, /\{!attachmentPreview\.remote && <><button title=\{zh \? "复制图片"/)
  assert.match(app, /if \(!attachmentPreview\.remote\) window\.shun\.showAttachmentImageMenu/)
})

test('a refresh fills in what the stream missed instead of choosing one copy', () => {
  const live = applyRemoteEvents(applyRemoteSnapshot(emptyRemoteTaskView('task_1'), snapshot({
    turns: [{ id: 'run_1', role: 'assistant', content: 'Hello', phase: { kind: 'planning', label: 'Thinking' }, timeline: [{ type: 'text', id: 'run_1-text-0', text: 'Hello' }] }],
  })), [event(11, 'turn.delta', { turnId: 'run_1', delta: ' world' })])

  // The peer's snapshot caps a turn's text for transport, but its timeline is the
  // list of what the run actually did. Picking one copy wholesale left a row that
  // never arrived missing for the rest of the run — a reply that read differently
  // here than on the machine that wrote it.
  const refreshed = applyRemoteSnapshot(live, snapshot({
    latestSeq: 20,
    turns: [{
      id: 'run_1', role: 'assistant', content: 'Hello', timeline: [
        { type: 'text', id: 'run_1-text-0', text: 'Hello' },
        { type: 'tool', id: 'tool_1', tool: tool('done', 'ok') },
      ],
    }],
  }))
  assert.equal(refreshed.turns[0].content, 'Hello world')
  assert.equal(refreshed.turns[0].timeline.length, 2)
  assert.equal(remoteTurnsAsLocal(refreshed)[0].timeline.length, 2)

  // The other half of the same rule: a snapshot that carries less text than this
  // view already has never shortens what the reader is looking at.
  const longer = applyRemoteEvents(live, [event(12, 'turn.delta', { turnId: 'run_1', delta: ' and more of it' })])
  const afterShort = applyRemoteSnapshot(longer, snapshot({ latestSeq: 21, turns: [{ id: 'run_1', role: 'assistant', content: 'Hello', timeline: [] }] }))
  assert.equal(afterShort.turns[0].content, 'Hello world and more of it')
  assert.equal(afterShort.turns[0].timeline.length, 1)
})

test('a refresh keeps the phase the peer is showing, and the running turn is its reply', async () => {
  const task = {
    id: 'task_1', title: 'T', workspace: '/tmp/work', createdAt: 1, updatedAt: 2,
    turns: [{
      id: 'run_1', role: 'assistant' as const, content: 'working', phase: 'Thinking', startedAt: 1,
      timeline: [{ type: 'text' as const, text: 'working' }],
    }],
  }
  const projected = remoteTaskSnapshot(task, 'run_1', 3)
  // Without the label, every refresh took the thinking row away from a reply that
  // was still being written: the conversation read as settled here while the other
  // machine kept working.
  assert.equal(projected.turns[0].phase?.label, 'Thinking')

  const view = applyRemoteSnapshot(emptyRemoteTaskView('task_1'), {
    taskId: 'task_1', latestSeq: 4, status: 'running', title: 'T', workspace: '/tmp/work',
    turns: [
      { id: 'run_1', role: 'assistant', content: 'working', phase: { kind: 'planning', label: 'Thinking' }, timeline: [] },
      { id: 'msg_2', role: 'user', content: 'and this', timeline: [] },
    ],
  })
  // The reply being written is the running turn, not the message this person just
  // sent: marking that one as running folded every row above it mid-run.
  assert.equal(remoteRunningTurnId(view), 'run_1')

  const app = await readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8')
  assert.match(app, /feedRunning = showRemote \? remoteRunningTurnId\(remote\.view\) : running,/)
})

test('a new task on the other machine is written in one of its folders, in the same composer', async () => {
  const [app, session] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8'),
  ])

  // The bar is placed by the context reading — every other conversation renders it
  // whether or not there is a reading yet, so leaving it out here put the controls
  // in a row on the left the moment a new task was being written.
  const barStart = app.indexOf('class={`bar${showRemote ? " remote-bar"')
  const bar = app.slice(barStart, app.indexOf('</> : <>', barStart))
  assert.doesNotMatch(bar, /\{remoteContext &&/)
  assert.match(bar, /<ContextMeter\s+value=\{remoteContext\}/)
  assert.match(bar, /modelWindow=\{remoteModelWindow \|\| settings\.contextWindow\}/)

  // A project is one of *its* folders: its own tasks name them, and any other
  // folder is walked to over the link, never resolved on this machine.
  assert.match(app, /\{showRemote && !remote\.open && \(\n\s+<div class="context-strip">/)
  assert.match(app, /class="project-trigger"/)
  assert.match(app, /setRemoteProjectMenu\(\(open\) => !open\)/)
  assert.match(app, /matchingRemoteWorkspaces = remotePeerWorkspaces\.filter\(/)
  assert.match(app, /\{zh \? "浏览那台机器的文件夹…" : "Browse folders over there…"\}/)
  assert.match(app, /void remote\.browseWorkspace\(\);/)
  assert.match(app, /chooseWorkspace\(browsing\.path\)/)
  assert.match(app, /function chooseRemoteWorkspace\(path: string\) \{\n\s+remote\.chooseWorkspace\(path\);/)

  // A new task usually continues the project someone was just in, and a person's
  // own choice is never replaced by that default.
  assert.match(session, /const inheritedWorkspace = useRef\(false\);/)
  assert.match(session, /if \(inheritedWorkspace\.current \|\| workspace \|\| !active\?\.id\) return;/)
  assert.match(session, /function chooseWorkspace\(path: string\) \{\n\s+inheritedWorkspace\.current = true;/)

  // The draft is not an empty window: it says where the task will run.
  assert.match(app, /\{showRemote && !remote\.open && \(\n\s+<div class="empty">/)
  assert.match(app, /上开始一个新任务/)
  assert.match(app, /会在这个项目里工作：/)
})
