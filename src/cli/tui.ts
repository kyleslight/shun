import { pastedImage } from './pasted-image.ts'
import { recentConversations } from '../conversation-list.ts'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { CombinedAutocompleteProvider, Container, Editor, Image, Input, ProcessTerminal, SelectList, Spacer, Text, TuiMainScreen, matchesKey, stripTerminalSequences, type Component, type SelectItem } from '@earendil-works/pi-tui'
import type { AttachmentRef, TaskEventEnvelope } from '../shared.ts'
import { applyHostEvent, attachmentLabel, type HostCall, type HostConfiguration, type HostSnapshot, type HostTask, type PublicProvider } from '../host/protocol.ts'
import { statusLine, gitStatus } from './status.ts'
import { slashCommands } from './commands.ts'
import { answerMarkdown, activityPhase } from './markdown.ts'
import { toolActivity, toolSummary } from './tool-activity.ts'
import { clipboardImage } from './clipboard.ts'
import { openDesktop } from './desktop.ts'
import { setupProvider } from './provider-setup.ts'
import { selectModel } from './model-selection.ts'
import { chooseSession, startSession } from './sessions.ts'
import { WelcomeHeader, accent } from './welcome.ts'

const plain = (value: string) => stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
const cyan = accent
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`
const theme = { selectedPrefix: cyan, selectedText: cyan, description: dim, scrollInfo: dim, noMatch: dim }
const apiChoices = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses']
const help = '/connect  /providers  /model  /resume  /session  /name <title>  /tasks  /new [folder|--no-workspace]  /clear  /trust  /paste  /attach <path>  /images  /processes  /skills  /desktop  /stop  /quit'

/** Only the input view masks secrets; provider keys never enter terminal history. */
class Composer extends Editor {
  secret = false
  override render(width: number): string[] {
    return this.secret ? new Text(`  ${'•'.repeat(Math.min(this.getText().length, Math.max(1, width - 4)))}`, 0, 0).render(width) : super.render(width)
  }
}

/** A bounded transcript keeps the composer visible while details are expanded. */
class TranscriptViewport extends Container {
  limit = () => 20
  top = 0
  private offset = Infinity
  private total = 0
  scroll(lines: number) { const end = Math.max(0, this.total - this.limit()); const next = Math.max(0, Math.min(end, this.top + lines)); this.offset = next === end ? Infinity : next }
  override render(width: number) {
    const all = super.render(width), height = Math.max(1, this.limit())
    this.total = all.length
    this.top = Math.min(this.offset, Math.max(0, all.length - height))
    return all.slice(this.top, this.top + height)
  }
}

export async function runTui(call: HostCall, options: { taskId?: string; workspace?: string; continueRecent?: boolean; resume?: boolean; onClose?: () => void } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Interactive Shun needs a terminal. Use shun run "message" for scripts.')
  const tui = new TuiMainScreen(new ProcessTerminal(), true)
  const header = new WelcomeHeader(), feed = new TranscriptViewport(), pending = new Container(), panel = new Container(), status = new Text('', 1, 0)
  const editor = new Composer(tui, { borderColor: cyan, selectList: theme }, { paddingX: 1 })
  for (const child of [header, feed, pending, panel, editor, status]) tui.addChild(child)
  feed.limit = () => Math.max(1, (process.stdout.rows || 24) - [header, pending, panel, editor, status].reduce((total, item) => total + item.render(process.stdout.columns || 80).length, 0))
  let snapshot: HostSnapshot | undefined, attachments: AttachmentRef[] = [], activeRun: string | undefined
  let animatedPhases: Array<{ view: Text; phase: string }> = []
  let visibleTurnLimit = 24
  const expandedTurns = new Set<string>()
  let toolRows: Array<{ start: number; end: number; id: string }> = []
  let closed = false, modal = false, busy = false, pollRunning = false, generation = 0, clipboardPending = false
  let lastInterrupt = 0, cancelModal: (() => void) | undefined
  const autocomplete = () => editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, snapshot?.task.workspace || process.cwd()))
  autocomplete(); editor.setAutocompleteMaxVisible(7)
  const drafts = new Map<string, { text: string; attachments: AttachmentRef[] }>()
  let finish!: () => void
  const completion = new Promise<void>(resolve => { finish = resolve })
  let git = '', gitWorkspace = '', gitChecked = 0, gitPending = false
  let statusNotice = '', statusNoticeUntil = 0
  const updateStatus = () => {
    const recorded = snapshot?.turns.findLast(turn => turn.contextUsage)?.contextUsage
    const context = recorded && !activeRun && snapshot?.task.contextWindow ? { ...recorded, budgetTokens: snapshot.task.contextWindow } : recorded
    status.setText(Date.now() < statusNoticeUntil ? plain(statusNotice) : dim(statusLine(snapshot?.task.model || '', snapshot?.task.workspace || '', git, context, (process.stdout.columns || 80) - 2)))
  }
  const notice = (message: string) => { if (closed) return; statusNotice = message; statusNoticeUntil = Date.now() + 6000; updateStatus(); tui.requestRender() }
  const safe = (work: () => Promise<unknown>) => { void work().catch(error => notice(error instanceof Error ? error.message : 'Shun operation failed.')) }
  const refresh = () => {
    const task = snapshot?.task
    header.update({ title: task?.title || '', model: task?.model || '', workspace: task?.workspace ?? options.workspace ?? '', running: Boolean(activeRun), compact: modal || Boolean(snapshot?.turns.length), ready: Boolean(task) })
    updateStatus()
    feed.clear(); toolRows = []; animatedPhases = []
    const width = process.stdout.columns || 80
    let row = header.render(width).length
    const turns = snapshot?.turns || []
    const hidden = Math.max(0, turns.length - visibleTurnLimit)
    if (hidden) {
      const earlier = new Text(dim(`▸ Show ${Math.min(24, hidden)} earlier messages · ${hidden} hidden`), 1, 0)
      feed.addChild(earlier)
      const size = earlier.render(width).length
      toolRows.push({ start: row, end: row + size, id: '__earlier__' }); row += size
    }
    for (const [index, turn] of turns.slice(hidden).entries()) {
      if (index > 0 && turn.role === 'user') { const gap = new Spacer(1); feed.addChild(gap); row += gap.render(width).length }
      const heading = new Text(turn.role === 'user' ? cyan('You') : cyan('Shun'), 1, 0)
      feed.addChild(heading); row += heading.render(width).length
      if (turn.tools?.length) {
        const expanded = expandedTurns.has(turn.id)
        const toggle = new Text(dim(`${expanded ? '▾' : '▸'} ${toolSummary(turn.tools, width)}`), 1, 0)
        feed.addChild(toggle)
        const size = toggle.render(width).length
        toolRows.push({ start: row, end: row + size, id: turn.id }); row += size
        const activity = toolActivity(turn.tools, expanded, width)
        if (activity) { const item = new Text(dim(activity), 1, 0); feed.addChild(item); row += item.render(width).length }
        if (expanded) { const hide = new Text(dim('▾ Hide details'), 1, 0); const size = hide.render(width).length; toolRows.push({ start: row, end: row + size, id: turn.id }); feed.addChild(hide); row += size }
      }
      const files = (turn.attachments || []).map(item => `  [${plain(attachmentLabel(item))}]`).join('\n')
      if (turn.content) {
        const body = turn.role === 'assistant' ? answerMarkdown(plain(turn.content)) : new Text(plain(turn.content), 1, 0)
        feed.addChild(body); row += body.render(width).length
      }
      if (files) { const item = new Text(files, 1, 0); feed.addChild(item); row += item.render(width).length }
      const running = turn.id === activeRun && !turn.completedAt
      const phase = running && turn.contextUsage?.state === 'compacting' ? 'Compacting' : turn.phase || (running && !turn.content ? 'Thinking' : '')
      if (phase) {
        const view = new Text(dim(activityPhase(plain(phase), running, Math.floor(Date.now() / 100))), 1, 0)
        feed.addChild(view); row += view.render(width).length
        if (running) animatedPhases.push({ view, phase: plain(phase) })
      }
    }
    tui.requestRender()
  }
  const showAttachments = () => {
    pending.clear()
    for (const item of attachments) pending.addChild(new Text(`[${plain(attachmentLabel(item))}]`, 1, 0))
    tui.requestRender()
  }
  const ask = (label: string, initial = '', secret = false) => new Promise<string>((resolve, reject) => {
    if (closed) { reject(Error('Shun closed.')); return }
    modal = true; refresh(); panel.clear(); panel.addChild(new Text(plain(label), 1, 1)); editor.secret = secret
    editor.setAutocompleteProvider({ getSuggestions: async () => null, applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }) })
    editor.setText(initial); editor.disableSubmit = false; tui.setFocus(editor)
    const dispose = tui.addInputListener(data => {
      if (!matchesKey(data, 'escape')) return
      cleanup(); reject(Error('Cancelled.')); return { consume: true }
    })
    const cleanup = () => { dispose(); modal = false; cancelModal = undefined; panel.clear(); editor.secret = false; autocomplete(); editor.setText(''); editor.onSubmit = submit; tui.setFocus(editor); if (!closed) refresh() }
    cancelModal = () => { cleanup(); reject(Error('Cancelled.')) }
    editor.onSubmit = value => { cleanup(); resolve(value) }
    tui.requestRender()
  })
  const choose = (label: string, items: SelectItem[]) => new Promise<string>((resolve, reject) => {
    if (closed) { reject(Error('Shun closed.')); return }
    modal = true; refresh(); panel.clear(); panel.addChild(new Text(plain(label), 1, 1))
    const list = new SelectList(items.map(item => ({ ...item, label: plain(item.label), description: item.description ? plain(item.description) : undefined })), 10, theme)
    const search = new Input()
    panel.addChild(search); panel.addChild(list)
    panel.addChild(new Text(dim('Type to search · ↑/↓ choose · Enter confirm · Esc / Ctrl+C cancel'), 1, 0))
    const controller = {
      get focused() { return search.focused }, set focused(value: boolean) { search.focused = value },
      render: (width: number) => search.render(width), invalidate: () => search.invalidate(),
      handleInput: (data: string) => {
        if ((['up', 'down', 'enter', 'escape'] as const).some(key => matchesKey(data, key))) list.handleInput(data)
        else { search.handleInput(data); list.setFilter(search.getValue()) }
        tui.requestRender()
      },
    }
    tui.setFocus(controller)
    const cleanup = () => { modal = false; cancelModal = undefined; panel.clear(); tui.setFocus(editor); if (!closed) refresh() }
    cancelModal = () => { cleanup(); reject(Error('Cancelled.')) }
    list.onSelect = item => { cleanup(); resolve(item.value) }
    list.onCancel = () => { cleanup(); reject(Error('Cancelled.')) }
    tui.requestRender()
  })
  const selectTask = async (id: string) => {
    if (snapshot) drafts.set(snapshot.task.id, { text: editor.getExpandedText(), attachments: [...attachments] })
    const epoch = ++generation
    const next = await call('task.snapshot', { taskId: id }) as HostSnapshot
    if (closed || epoch !== generation) return
    visibleTurnLimit = 24; expandedTurns.clear()
    snapshot = next; activeRun = next.activeRun; autocomplete()
    const draft = drafts.get(id)
    attachments = draft?.attachments || []; editor.setText(draft?.text || '')
    showAttachments(); refresh()
    statusNoticeUntil = 0; updateStatus()
  }
  const configureModel = async (taskId?: string, selectedProviderId?: string) => {
    const config = await call('configuration') as HostConfiguration
    if (!config.providers.length) throw Error('Add a provider with /providers first.')
    const providerId = selectedProviderId || (config.providers.length === 1 ? config.providers[0].id : await choose('Choose provider', config.providers.map(provider => ({ value: provider.id, label: provider.name }))))
    let models: string[] = []
    notice('Loading models…')
    try { models = await call('provider.models', { id: providerId }) } catch { notice('Model discovery unavailable. Enter a model ID manually.') }
    let model = await choose('Choose model', [...models.map(model => ({ value: model, label: model })), { value: '__custom__', label: 'Enter a model ID…' }])
    if (model === '__custom__') model = await ask('Model ID')
    await selectModel(call, providerId, model, taskId)
    if (taskId && snapshot?.task.id === taskId) { snapshot.task.providerId = providerId; snapshot.task.model = model; refresh() }
  }
  const editProvider = async (provider?: PublicProvider) => {
    const name = await ask('Provider name', provider?.name)
    const endpoint = await ask('API base URL', provider?.endpoint || 'http://localhost:11434/v1')
    const api = await choose('API format', apiChoices.map(api => ({ value: api, label: api })))
    const apiKey = await ask(provider?.hasKey ? 'API key — leave blank to keep the existing key' : 'API key — leave blank for a local service', '', true)
    const contextWindow = Number(await ask('Context window (tokens)', String(provider?.contextWindow || 32768)))
    await call('provider.save', { id: provider?.id, name, endpoint, api, apiKey, contextWindow })
    notice('Provider saved.')
  }
  const providers = async () => {
    const config = await call('configuration') as HostConfiguration
    const id = await choose('Providers', [...config.providers.map(provider => ({ value: provider.id, label: provider.name, description: provider.endpoint })), { value: '__add__', label: 'Add provider…' }])
    if (id === '__add__') { await configureModel(snapshot?.task.id, await setupProvider(call, { ask, choose })); return }
    const provider = config.providers.find(item => item.id === id)!
    const action = await choose(provider.name, ['Select model', 'Update API key', 'Advanced settings', 'Test model', 'Clear API key', 'Remove'].map(label => ({ value: label, label })))
    if (action === 'Select model') await configureModel(snapshot?.task.id, id)
    if (action === 'Update API key') { const apiKey = await ask(`${provider.name} · API key — leave blank to keep existing key`, '', true); await call('provider.save', { ...provider, apiKey }); notice('API key updated.') }
    if (action === 'Advanced settings') await editProvider(provider)
    if (action === 'Test model') { const model = await ask('Model ID', snapshot?.task.model); notice('Testing connection…'); const result = await call('provider.test', { id, model }); notice(`${result.ok ? 'Connected' : 'Failed'} · ${result.latencyMs}ms · ${result.message}`) }
    if (action === 'Clear API key') { await call('provider.save', { ...provider, apiKey: null }); notice('API key cleared.') }
    if (action === 'Remove' && await choose(`Remove ${provider.name}?`, [{ value: 'no', label: 'Keep' }, { value: 'yes', label: 'Remove' }]) === 'yes') await call('provider.remove', { id })
  }
  const trust = async () => {
    if (!snapshot) return
    const trusted = await choose('Load project-local settings and extensions? This is separate from file and shell access.', [{ value: 'no', label: 'Do not trust project configuration' }, { value: 'yes', label: 'Trust this project' }]) === 'yes'
    await call('task.trust', { taskId: snapshot.task.id, trusted }); snapshot.trustRequired = false
  }
  const addImage = async (bytes: Buffer, name: string) => {
    if (!snapshot) throw Error('Create a task first.')
    if (attachments.length >= 16) throw Error('Attach at most 16 images.')
    const taskId = snapshot.task.id
    const item = await call('attachment.add', { taskId, name, data: bytes.toString('base64') }) as AttachmentRef
    if (item.kind !== 'image') throw Error('Choose an image file.')
    if (snapshot.task.id !== taskId) return
    if (!attachments.some(existing => existing.id === item.id)) attachments.push(item)
    showAttachments(); notice(`Attached ${attachmentLabel(item)}. /images to preview or remove.`)
  }
  const command = async (line: string) => {
    const space = line.indexOf(' '), name = space < 0 ? line : line.slice(0, space), argument = space < 0 ? '' : line.slice(space + 1).trim()
    if (name === '/quit') { close(); return }
    if (name === '/help') {
      const selected = await choose('Commands · choose to insert', slashCommands.map(item => ({ value: item.name, label: `/${item.name}`, description: item.description })))
      editor.setText(`/${selected} `); tui.requestRender(); return
    }
    if (name === '/providers') { await providers(); return }
    if (name === '/connect' || name === '/login') { await configureModel(snapshot?.task.id, await setupProvider(call, { ask, choose })); return }
    if (name === '/model') { await configureModel(snapshot?.task.id); return }
    if (name === '/activity' || name === '/memory') {
      const overview = await call('assistant.overview');
      if (name === '/activity') {
        if (!overview.runs.length) { notice('No assistant activity yet.'); return }
        const id = await choose('Assistant activity', overview.runs.map((run: { id: string; title: string; status: string }) => ({ value: run.id, label: run.title, description: run.status })));
        await selectTask(id);
      } else {
        notice(overview.memories.length ? overview.memories.map((memory: { text: string }) => `• ${memory.text}`).join('\n') : 'No saved memories. Ask Shun to remember something.');
      }
      return;
    }
    if (name === '/assistant') { const task = await call('assistant.open'); await selectTask(task.id); return }
    if (name === '/new' || name === '/clear') {
      const workspace = argument === '--no-workspace' ? '' : argument ? resolve(argument) : snapshot?.task.workspace ?? options.workspace ?? ''
      const task = await call('task.create', { workspace }) as HostTask
      await selectTask(task.id); return
    }
    if (name === '/resume') {
      const workspace = snapshot?.task.workspace ?? options.workspace ?? ''
      const id = await chooseSession(call, workspace, choose)
      const task = id ? { id } : await call('task.create', { workspace })
      await selectTask(task.id); return
    }
    if (name === '/session') { if (snapshot) notice(`Session: ${snapshot.task.id} · ${snapshot.task.workspace || 'No project selected'}`); return }
    if (name === '/name') { if (!snapshot) throw Error('Create a conversation first.'); snapshot.task = await call('task.rename', { taskId: snapshot.task.id, title: argument }); refresh(); return }
    if (name === '/tasks') {
      const tasks = recentConversations(await call('task.list') as Array<HostTask & { activeRun?: string }>)
      const id = await choose('Tasks', tasks.map(task => ({ value: task.id, label: `${task.activeRun ? '● ' : ''}${task.title}`, description: task.workspace })))
      await selectTask(id); return
    }
    if (!snapshot) throw Error('Create a task with /new first.')
    if (name === '/stop') { await call('task.stop', { taskId: snapshot.task.id }); return }
    if (name === '/trust') { await trust(); return }
    if (name === '/paste') { await addImage(await clipboardImage(), `Screenshot-${Date.now()}.png`); return }
    if (name === '/attach') { const path = resolve(argument.replace(/^(['"])(.*)\1$/, '$2')); await addImage(await readFile(path), basename(path)); return }
    if (name === '/images') {
      if (!attachments.length) throw Error('No pending images. Use /paste or /attach to add one.')
      const id = await choose('Pending images', attachments.map(item => ({ value: item.id, label: attachmentLabel(item) })))
      const action = await choose('Image', [{ value: 'preview', label: 'Preview' }, { value: 'remove', label: 'Remove from message' }])
      if (action === 'remove') { attachments = attachments.filter(item => item.id !== id); showAttachments() }
      else {
        const preview = await call('attachment.preview', { taskId: snapshot.task.id, id })
        if (preview.mode !== 'image') throw Error('Image preview is unavailable.')
        pending.addChild(new Image(preview.data, preview.mimeType, { fallbackColor: dim }, { maxWidthCells: 60, maxHeightCells: 16 }))
        tui.requestRender()
      }
      return
    }
    if (name === '/desktop') { await openDesktop(snapshot.task.id); notice('Opening this task in Shun Desktop. It continues running here.'); return }
    if (name === '/processes') {
      const processes = await call('background.list') as Array<{ id: string; sessionId: string; label: string; state: string }>
      if (!processes.length) throw Error('No background processes.')
      const id = await choose('Background processes', processes.map(item => ({ value: item.id, label: item.label || item.id, description: item.state })))
      const item = processes.find(item => item.id === id)!
      const action = await choose('Process', [{ value: 'read', label: 'View output' }, { value: 'stop', label: 'Stop process' }])
      notice(JSON.stringify(await call(`background.${action}`, { taskId: item.sessionId, id }))); return
    }
    if (name === '/skills') {
      const skills = await call('skill.list', { taskId: snapshot.task.id }) as Array<{ id: string; name: string; enabled: boolean }>
      const id = await choose('Agent Skills', [...skills.map(item => ({ value: item.id, label: item.name, description: item.enabled ? 'Enabled' : 'Disabled' })), { value: '__install__', label: 'Install Skill package…' }])
      if (id === '__install__') notice(JSON.stringify(await call('skill.install', { source: await ask('Skill package source') })))
      else { const skill = skills.find(item => item.id === id)!; await call('skill.toggle', { id, enabled: !skill.enabled }); notice('Skill updated. Available on the next run without restarting.') }
      return
    }
    throw Error(`Unknown command. ${help}`)
  }
  async function submit(value: string) {
    if (busy || clipboardPending) { if (!editor.getText()) editor.setText(value); notice('Wait for the current input action to finish.'); return }
    busy = true
    editor.disableSubmit = true
    try {
      if (value.startsWith('/')) { editor.setText(''); await command(value); return }
      if (!snapshot) throw Error('Create a task with /new first.')
      if (activeRun) throw Error('This task is running. Keep drafting, or use /stop.')
      if (snapshot.trustRequired) await trust()
      if (!snapshot.task.model) await configureModel(snapshot.task.id)
      const result = await call('task.send', { taskId: snapshot.task.id, text: value, attachments: attachments.map(item => item.id) })
      activeRun = result.runId; editor.addToHistory(value); attachments = []; showAttachments(); refresh()
    } catch (error) {
      if (!value.startsWith('/') && !editor.getText()) editor.setText(value)
      notice(error instanceof Error ? error.message : 'Shun operation failed.')
    }
    finally { busy = false; editor.disableSubmit = false }
  }
  editor.onSubmit = value => { void submit(value) }
  function close() {
    if (closed) return
    closed = true; cancelModal?.(); clearInterval(timer); clearInterval(animationTimer); tui.terminal.write('\x1b[?1000l\x1b[?1006l'); tui.stop()
    if (snapshot?.turns.length) process.stdout.write(`\n${activeRun ? 'Task continues running in Shun.\n' : ''}Resume this conversation:\n  shun --session ${plain(snapshot.task.id)}\n`)
    options.onClose?.(); finish()
  }
  const animationTimer = setInterval(() => {
    if (closed) return
    updateStatus()
    for (const { view, phase } of animatedPhases) view.setText(dim(activityPhase(phase, true, Math.floor(Date.now() / 100))))
    tui.requestRender()
  }, 100)
  const timer = setInterval(() => {
    if (closed || pollRunning || !snapshot) return
    const workspace = snapshot.task.workspace
    if (!gitPending && (workspace !== gitWorkspace || Date.now() - gitChecked > 5000)) {
      if (workspace !== gitWorkspace) git = ''
      gitWorkspace = workspace; gitPending = true; gitChecked = Date.now()
      void gitStatus(workspace).then(value => { if (snapshot?.task.workspace === workspace) { git = value; updateStatus(); tui.requestRender() } }).finally(() => { gitPending = false })
    }
    pollRunning = true
    const id = snapshot.task.id, epoch = generation
    void call('task.events', { taskId: id, after: snapshot.sequence }).then((batch: { events: TaskEventEnvelope[]; snapshot?: HostSnapshot; activeRun?: string; task: HostTask; trustRequired: boolean }) => {
      if (!snapshot || snapshot.task.id !== id || generation !== epoch) return
      if (batch.snapshot) { snapshot.turns = batch.snapshot.turns; snapshot.sequence = batch.snapshot.sequence }
      for (const event of batch.events) if (event.seq > snapshot.sequence) { applyHostEvent(snapshot.turns, event); snapshot.sequence = event.seq }
      const changed = Boolean(batch.snapshot) || activeRun !== batch.activeRun || batch.events.length || JSON.stringify(snapshot.task) !== JSON.stringify(batch.task)
      snapshot.task = batch.task; snapshot.trustRequired = batch.trustRequired
      activeRun = batch.activeRun
      if (changed) refresh()
    }).catch(() => notice('Disconnected. Shun will reconnect; your draft is preserved.')).finally(() => { pollRunning = false })
  }, 250)
  let pasteBuffer: string | undefined
  tui.addInputListener(data => {
    if (!modal && (pasteBuffer !== undefined || data.startsWith('\x1b[200~'))) {
      pasteBuffer = pasteBuffer === undefined ? data.slice(6) : pasteBuffer + data
      const end = pasteBuffer.indexOf('\x1b[201~')
      if (end < 0) return { consume: true }
      const pasted = pasteBuffer.slice(0, end), trailing = pasteBuffer.slice(end + 6)
      pasteBuffer = undefined
      const fallback = () => { editor.handleInput(`\x1b[200~${pasted}\x1b[201~`); if (trailing) editor.handleInput(trailing); tui.requestRender() }
      if (busy || clipboardPending) { fallback(); return { consume: true } }
      clipboardPending = true
      safe(async () => {
        try {
          const image = await pastedImage(pasted)
          if (image) { await addImage(image.bytes, image.name); if (trailing) editor.handleInput(trailing) }
          else if (!pasted) await addImage(await clipboardImage(), `Screenshot-${Date.now()}.png`)
          else fallback()
        } catch (error) { fallback(); throw error }
        finally { clipboardPending = false }
      })
      return { consume: true }
    }

    if (matchesKey(data, 'ctrl+c')) {
      if (modal) { lastInterrupt = 0; cancelModal?.(); return { consume: true } }
      if (busy) return { consume: true }
      if (activeRun && snapshot) {
        lastInterrupt = 0
        const taskId = snapshot.task.id
        safe(async () => {
          busy = true
          try { await call('task.stop', { taskId }); notice('Stopping…') }
          finally { busy = false }
        })
        return { consume: true }
      }
      if (snapshot?.turns.length) {
        lastInterrupt = 0
        safe(async () => {
          busy = true
          try { await command('/new') }
          finally { busy = false }
        })
        return { consume: true }
      }
      const now = Date.now()
      if (now - lastInterrupt < 500) close()
      else { lastInterrupt = now; editor.setText(''); notice('Press Ctrl+C again to exit.') }
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+d') && !editor.getText() && !modal) { close(); return { consume: true } }
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data)
    if (mouse) {
      if (!modal && ['64', '65'].includes(mouse[1])) { feed.scroll(mouse[1] === '64' ? -3 : 3); tui.requestRender(true) }
      if (!modal && mouse[1] === '0' && mouse[4] === 'M') {
        const row = Number(mouse[3]) - 1 + feed.top
        const screenRow = Number(mouse[3]) - 1
        const start = header.render(process.stdout.columns || 80).length
        const hit = screenRow >= start && screenRow < start + feed.render(process.stdout.columns || 80).length ? toolRows.find(item => row >= item.start && row < item.end) : undefined
        if (hit) {
          if (hit.id === '__earlier__') { visibleTurnLimit += 24; refresh(); tui.requestRender(true); return { consume: true } }
          if (expandedTurns.has(hit.id)) expandedTurns.delete(hit.id); else expandedTurns.add(hit.id)
          refresh(); tui.requestRender(true)
        }
      }
      return { consume: true }
    }
    if (modal) return
    if (matchesKey(data, 'ctrl+o')) {
      const turns = (snapshot?.turns || []).filter(turn => turn.tools?.length)
      const expand = turns.some(turn => !expandedTurns.has(turn.id))
      expandedTurns.clear()
      if (expand) turns.forEach(turn => expandedTurns.add(turn.id))
      refresh(); tui.requestRender(true)
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+v') || (process.platform === 'darwin' && matchesKey(data, 'super+v'))) {
      if (busy) { notice('Wait for the current input action to finish.'); return { consume: true } }
      if (!clipboardPending) {
        clipboardPending = true
        safe(async () => { try { await addImage(await clipboardImage(), `Screenshot-${Date.now()}.png`) } finally { clipboardPending = false } })
      }
      return { consume: true }
    }
  })
  tui.start(); tui.terminal.write('\x1b[?1000h\x1b[?1006h'); tui.setFocus(editor); refresh(); tui.requestRender(true)
  const onSignal = () => close()
  process.stdout.on('resize', refresh)
  process.once('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  try {
    const config = await call('configuration') as HostConfiguration
    if (!config.providers.length) await configureModel(undefined, await setupProvider(call, { ask, choose }))
    else if (!config.model) await configureModel()
    const task = await startSession(call, { ...options, workspace: options.workspace ?? '' }, choose)
    await selectTask(task.id)
  } catch (error) {
    if (options.resume && error instanceof Error && error.message === 'Cancelled.') close()
    else notice(`${error instanceof Error ? error.message : 'Setup failed.'} Use /providers, /model, or /new to continue.`)
  }
  await completion
  process.stdout.off('resize', refresh)
  process.off('SIGTERM', onSignal)
  process.off('SIGINT', onSignal)
}
