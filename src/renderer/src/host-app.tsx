import { useEffect, useRef, useState } from 'preact/hooks'
import type { AttachmentRef, TaskEventEnvelope } from '../../shared'
import { applyHostEvent, attachmentLabel, hostToolLabel, type HostCall, type HostConfiguration, type HostSnapshot, type HostTask, type PublicProvider } from '../../host/protocol'
import './host-app.css'

declare global { interface Window { shunHost: { call: HostCall; onSelect(listener: (taskId: string) => void): () => void } } }
const call = (method: string, input?: Record<string, unknown>) => window.shunHost.call(method, input)
const emptyProvider = { name: '', endpoint: '', api: 'openai-completions', apiKey: '', contextWindow: 32768 }

export function HostApp() {
  const [tasks, setTasks] = useState<Array<HostTask & { activeRun?: string }>>([])
  const [snapshot, setSnapshot] = useState<HostSnapshot>()
  const held = useRef<HostSnapshot>(), epoch = useRef(0)
  const [draft, setDraft] = useState(''), [images, setImages] = useState<AttachmentRef[]>([])
  const drafts = useRef(new Map<string, { text: string; images: AttachmentRef[] }>())
  const draftRef = useRef({ text: draft, images }); draftRef.current = { text: draft, images }
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [connected, setConnected] = useState(false)
  const [config, setConfig] = useState<HostConfiguration>({ providers: [], providerId: '', model: '' })
  const [settings, setSettings] = useState(false), [providerForm, setProviderForm] = useState<typeof emptyProvider & { id?: string }>(emptyProvider)
  const [model, setModel] = useState(''), [providerId, setProviderId] = useState(''), [models, setModels] = useState<string[]>([])
  const [resource, setResource] = useState(''), [preview, setPreview] = useState(''), [workspace, setWorkspace] = useState('')
  const feed = useRef<HTMLDivElement>(null), follow = useRef(true)
  const notice = (error: unknown) => setError(error instanceof Error ? error.message : 'Shun operation failed.')
  const attempt = async (work: () => Promise<unknown>) => { setError(''); try { await work() } catch (error) { notice(error) } }
  const refreshConfig = async () => { const next = await call('configuration') as HostConfiguration; setConfig(next); return next }
  const update = (next: HostSnapshot) => { held.current = next; setSnapshot({ ...next, turns: [...next.turns] }) }
  const select = async (id: string) => {
    const current = held.current
    if (current) drafts.current.set(current.task.id, draftRef.current)
    const ticket = ++epoch.current
    const next = await call('task.snapshot', { taskId: id }) as HostSnapshot
    if (ticket !== epoch.current) return
    if (current && held.current?.task.id === current.task.id) drafts.current.set(current.task.id, draftRef.current)
    update(next); const saved = drafts.current.get(id)
    setDraft(saved?.text || ''); setImages(saved?.images || []); setPreview('')
    setProviderId(next.task.providerId); setModel(next.task.model); follow.current = true
  }
  useEffect(() => {
    let disposed = false, polling = false, count = 0
    const start = async () => {
      await call('hello'); if (disposed) return
      setConnected(true)
      const config = await refreshConfig()
      if (!config.providers.length) setSettings(true)
      const tasks = await call('task.list'); if (disposed) return
      setTasks(tasks)
      const id = new URLSearchParams(location.search).get('task') || tasks[0]?.id
      if (id) await select(id)
    }
    void start().catch(notice)
    const dispose = window.shunHost.onSelect(id => { if (id) void attempt(() => select(id)) })
    const timer = setInterval(() => {
      if (polling || disposed) return
      polling = true
      const current = held.current, ticket = epoch.current
      void (async () => {
        if (current) {
          const result = await call('task.events', { taskId: current.task.id, after: current.sequence }) as { events: TaskEventEnvelope[]; activeRun?: string; task: HostTask; trustRequired: boolean }
          if (!disposed && held.current === current && epoch.current === ticket) {
            for (const event of result.events) if (event.seq > current.sequence) { applyHostEvent(current.turns, event); current.sequence = event.seq }
            current.activeRun = result.activeRun
            current.task = result.task; current.trustRequired = result.trustRequired
            update(current)
          }
        } else await call('hello')
        if (++count % 5 === 0) { const list = await call('task.list'); if (!disposed) setTasks(list) }
        if (!disposed) setConnected(true)
      })().catch(() => { if (!disposed) setConnected(false) }).finally(() => { polling = false })
    }, 300)
    return () => { disposed = true; dispose(); clearInterval(timer) }
  }, [])
  useEffect(() => { if (follow.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight }, [snapshot?.sequence, snapshot?.task.id])
  const upload = async (files: File[]) => {
    const current = held.current
    if (!current) throw Error('Create or select a task first.')
    if (images.length + files.length > 16) throw Error('Attach at most 16 images.')
    setBusy(true)
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) throw Error('Choose an image smaller than 20 MB.')
        const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(Error('Could not read image.')); reader.readAsDataURL(file) })
        const item = await call('attachment.add', { taskId: current.task.id, name: file.name || 'Screenshot.png', data })
        if (held.current?.task.id === current.task.id) setImages(items => items.some(existing => existing.id === item.id) ? items : [...items, item])
      }
    } finally { setBusy(false) }
  }
  const send = async () => {
    const current = held.current
    if (!current || busy) return
    setBusy(true)
    const ticket = epoch.current
    try {
      const { runId } = await call('task.send', { taskId: current.task.id, text: draft, attachments: images.map(item => item.id) })
      drafts.current.set(current.task.id, { text: '', images: [] })
      if (epoch.current === ticket && held.current?.task.id === current.task.id) {
        held.current.activeRun = runId; update(held.current); setDraft(''); setImages([]); setPreview(''); follow.current = true
      }
    } finally { setBusy(false) }
  }
  const openImage = async (item: AttachmentRef) => {
    const result = await call('attachment.preview', { taskId: item.taskId, id: item.id })
    if (result.mode === 'image') setPreview(`data:${result.mimeType};base64,${result.data}`)
  }
  const editProvider = (provider: PublicProvider) => setProviderForm({ id: provider.id, name: provider.name, endpoint: provider.endpoint, api: provider.api || 'openai-completions', apiKey: '', contextWindow: provider.contextWindow })
  return <div class="shun-host">
    <aside class="host-sidebar">
      <header><strong>Shun</strong><span>Shared workspace</span></header>
      <button onClick={() => setSettings(true)}>Providers & models</button>
      <form onSubmit={event => { event.preventDefault(); void attempt(async () => { const task = await call('task.create', { workspace }); setWorkspace(''); await select(task.id); setTasks(await call('task.list')) }) }}>
        <input aria-label="New task workspace" placeholder="Folder path · leave empty for no workspace" value={workspace} onInput={event => setWorkspace(event.currentTarget.value)} />
        <button>New task</button>
      </form>
      <nav>{tasks.map(task => <button class={snapshot?.task.id === task.id ? 'selected' : ''} key={task.id} onClick={() => void attempt(() => select(task.id))}><span>{task.activeRun ? '● ' : ''}{task.title}</span><small>{task.model || 'Choose a model'}</small></button>)}</nav>
      <footer>Terminal and desktop share these tasks.<br />Closing this window leaves tasks running.</footer>
    </aside>
    <main>
      <header class="host-toolbar"><div><strong>{snapshot?.task.title || 'Your Shun workspace'}</strong><small>{snapshot ? snapshot.task.workspace || 'No workspace · managed working directory' : 'Start in the terminal, or create a task here.'}</small></div>
        <button onClick={() => void attempt(async () => setResource(JSON.stringify(await call('background.list'), null, 2)))}>Processes</button>
        <span class={connected ? 'host-online' : 'host-offline'}>{connected ? 'Connected' : 'Reconnecting…'}</span>
      </header>
      {!connected && <div class="host-notice">Start <code>shun</code> in your terminal to connect the local task service.</div>}
      <div class="host-feed" ref={feed} onScroll={() => { if (feed.current) follow.current = feed.current.scrollHeight - feed.current.scrollTop - feed.current.clientHeight < 80 }}>
        {snapshot?.turns.map(turn => <article key={turn.id} class={`host-turn host-${turn.role}`}><h3>{turn.role === 'user' ? 'You' : 'Shun'}</h3><div class="host-message">{turn.content}</div>
          {turn.attachments?.map(item => <button class="host-attachment" onClick={() => void attempt(() => openImage(item))}>{attachmentLabel(item)}</button>)}
          {turn.tools?.map(tool => <details key={tool.id}><summary>{hostToolLabel(tool)} · {tool.state}</summary><pre>{tool.input}</pre><pre>{tool.output}</pre></details>)}
          {turn.phase && <small>{turn.phase}</small>}
        </article>)}
        {snapshot?.activeRun && <div class="host-working">Shun is working…</div>}
      </div>
      {snapshot?.trustRequired && <div class="host-notice">Load this project’s local settings and extensions? This is separate from file and shell access.
        {[false, true].map(trusted => <button onClick={() => void attempt(async () => { await call('task.trust', { taskId: snapshot.task.id, trusted }); update({ ...held.current!, trustRequired: false }) })}>{trusted ? 'Trust project' : 'Do not trust'}</button>)}
      </div>}
      <section class="host-composer">
        {error && <div role="alert" class="host-error">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
        <div class="host-options"><button onClick={() => setSettings(true)}>{snapshot?.task.model || 'Choose model'}</button>
        </div>
        <div>{images.map(item => <span class="host-attachment"><button onClick={() => void attempt(() => openImage(item))}>{attachmentLabel(item)}</button><button aria-label={`Remove ${item.name}`} onClick={() => setImages(items => items.filter(existing => existing.id !== item.id))}>×</button></span>)}</div>
        <textarea aria-label="Message" disabled={busy} placeholder="Message Shun. Paste a screenshot or attach an image." value={draft} onInput={event => setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!snapshot?.activeRun) void attempt(send) } }} onPaste={event => { const files = [...(event.clipboardData?.files || [])]; if (files.length) { event.preventDefault(); void attempt(() => upload(files)) } }} />
        <div class="host-send"><label class="host-file">Attach image<input type="file" accept="image/*" multiple disabled={busy} onChange={event => { const files = [...(event.currentTarget.files || [])]; event.currentTarget.value = ''; void attempt(() => upload(files)) }} /></label>
          {snapshot?.activeRun ? <button onClick={() => void attempt(() => call('task.stop', { taskId: snapshot.task.id }))}>Stop</button> : <button class="primary" disabled={!snapshot || busy || snapshot.trustRequired || (!draft.trim() && !images.length)} onClick={() => void attempt(send)}>Send</button>}
        </div>
      </section>
    </main>
    {settings && <div class="host-overlay"><section class="host-dialog"><header><h2>Providers & models</h2><button onClick={() => setSettings(false)}>Close</button></header>
      <div class="host-provider-list">{config.providers.map(provider => <button onClick={() => editProvider(provider)}>{provider.name}</button>)}<button onClick={() => setProviderForm(emptyProvider)}>Add provider</button></div>
      <form onSubmit={event => { event.preventDefault(); void attempt(async () => { await call('provider.save', providerForm); await refreshConfig(); setProviderForm(emptyProvider) }) }}>
        <label>Name<input required value={providerForm.name} onInput={event => setProviderForm({ ...providerForm, name: event.currentTarget.value })} /></label>
        <label>API base URL<input required type="url" value={providerForm.endpoint} onInput={event => setProviderForm({ ...providerForm, endpoint: event.currentTarget.value })} /></label>
        <label>API format<select value={providerForm.api} onChange={event => setProviderForm({ ...providerForm, api: event.currentTarget.value })}>{['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses'].map(api => <option>{api}</option>)}</select></label>
        <label>API key<input type="password" autoComplete="off" placeholder="Leave blank to keep existing key" value={providerForm.apiKey} onInput={event => setProviderForm({ ...providerForm, apiKey: event.currentTarget.value })} /></label>
        <label>Context window<input type="number" min="1024" max="10000000" value={providerForm.contextWindow} onInput={event => setProviderForm({ ...providerForm, contextWindow: Number(event.currentTarget.value) })} /></label>
        <button>Save provider</button>{providerForm.id && <button type="button" onClick={() => void attempt(async () => { await call('provider.remove', { id: providerForm.id }); setProviderForm(emptyProvider); await refreshConfig() })}>Remove provider</button>}
      </form>
      <hr /><label>Provider<select value={providerId} onChange={event => { setProviderId(event.currentTarget.value); setModels([]) }}><option value="">Choose provider</option>{config.providers.map(provider => <option value={provider.id}>{provider.name}</option>)}</select></label>
      <label>Model ID<input list="host-models" value={model} onInput={event => setModel(event.currentTarget.value)} /><datalist id="host-models">{models.map(model => <option value={model} />)}</datalist></label>
      <button disabled={!providerId} onClick={() => void attempt(async () => setModels(await call('provider.models', { id: providerId })))}>Discover models</button>
      <button disabled={!providerId || !model} onClick={() => void attempt(async () => { const result = await call('provider.test', { id: providerId, model }); setError(`${result.ok ? 'Connected' : 'Failed'} · ${result.latencyMs}ms · ${result.message}`) })}>Test connection</button>
      <button disabled={!providerId || !model} onClick={() => void attempt(async () => { await call('model.select', { providerId, model }); if (snapshot) { await call('model.select', { providerId, model, taskId: snapshot.task.id }); update({ ...held.current!, task: { ...held.current!.task, providerId, model } }) } await refreshConfig(); setSettings(false) })}>Use model</button>
      {error && <p class="host-error" role="alert">{error}</p>}
    </section></div>}
    {(resource || preview) && <div class="host-overlay"><section class="host-dialog"><button onClick={() => { setResource(''); setPreview('') }}>Close</button>{preview ? <img src={preview} alt="Task attachment" /> : <pre>{resource}</pre>}</section></div>}
  </div>
}
