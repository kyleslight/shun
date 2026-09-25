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
  const session = await readFile(new URL('../renderer/src/remote-session.ts', import.meta.url), 'utf8')
  const console = session + app.slice(app.indexOf('function RemotePanels('), app.indexOf('function PairingDialog('))

  assert.match(console, /command\("task\.message\.send", \{ taskId: target\.taskId, text, attachments: \[\] \}/)
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

  assert.match(app, /<Monitor \/>\n\s+<span>\{zh \? "远端" : "Remote"\}<\/span>/)
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
  assert.match(session, /if \(view\?\.status !== "running" \|\| !open\) return;/)
  assert.match(session, /\}, REMOTE_LIVE_RECOVERY_MS\);/)
  assert.match(session, /void refreshFromSnapshot\(target\);\n\s+void loadTasks\(target\.desktopId, true\);/)


  // A device name is long and a link state is short: the row lays them out
  // itself rather than letting a floating label land on the name.
  assert.match(css, /\.remote-device\{display:grid;grid-template-columns:8px minmax\(0,1fr\) auto/)
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
  assert.match(app, /\}, \[showRemote, remote\.view\?\.ready, remote\.view\?\.latestSeq, remote\.view\?\.turns\.length\]\);/)

  // The composer is the same bar as any other conversation: the peer's own
  // context reading on the left, the one control that always applies on the right.
  assert.match(app, /remoteContext = showRemote \? \(\(\) => \{/)
  assert.match(app, /<div class=\{`bar\$\{showRemote \? " remote-bar" : ""\}`\}>/)
  assert.match(css, /\.remote-bar \.send\{margin-left:auto\}/)
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
