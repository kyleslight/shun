import { useEffect, useRef, useState } from 'preact/hooks'
import { X, ChevronRight, MoreHorizontal, LoaderCircle, ArrowUpRight, Pencil, Trash2 } from 'lucide-preact'
import type { AssistantOverview } from '../../shared'
import { AssistantMark } from './assistant-mark'
import './assistant-panel.css'

export function AssistantPanel({ language, close, openTask, openSchedules }: { language: string; close: () => void; openTask: (id: string) => void; openSchedules: () => void }) {
  const zh = language.startsWith('zh')
  const [data, setData] = useState<AssistantOverview>()
  const [tab, setTab] = useState<'memories' | 'runs'>('runs')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string>()
  const [text, setText] = useState('')
  const root = useRef<HTMLElement>(null)
  const refreshing = useRef(false)
  const refresh = async () => {
    if (refreshing.current) return
    refreshing.current = true
    try { setData(await window.shun.assistantOverview()); setError('') }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { refreshing.current = false }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement
    root.current?.focus()
    void refresh()
    const timer = setInterval(refresh, 10000)
    return () => { clearInterval(timer); previous?.focus() }
  }, [])
  const update = async (id: string, remove = false) => {
    try { await window.shun.assistantMemoryUpdate({ id, text, remove }); setEditing(undefined); await refresh() }
    catch (error) { setError(String(error)) }
  }
  const runRow = (run: AssistantOverview['runs'][number]) => <button key={run.id} class="assistant-record assistant-run" onClick={() => openTask(run.id)}><span><strong>{run.title}</strong><small><i class={`assistant-status ${run.status}`} />{run.status === 'running' ? (zh ? '进行中' : 'Running') : run.status === 'error' ? (zh ? '未完成' : 'Failed') : (zh ? '已完成' : 'Done')} · {new Date(run.updatedAt).toLocaleString(language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></span><ChevronRight /></button>
  const active = data?.runs.filter(run => run.status === 'running') || []
  const recent = data?.runs.filter(run => run.status !== 'running') || []
  return <div class="assistant-panel-backdrop" onClick={close}><section ref={root} tabIndex={-1} class="assistant-panel" role="dialog" aria-modal="true" aria-label={zh ? '动态与记忆' : 'Activity & memory'} onClick={event => event.stopPropagation()} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); close() }
    if (event.key === 'Tab') {
      const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, textarea, summary')].filter(el => el.getClientRects().length)
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <header><div class="assistant-panel-identity"><AssistantMark /><h2>Shun</h2></div><button class="assistant-close" onClick={close} aria-label={zh ? '关闭' : 'Close'}><X /></button></header>
    <nav aria-label={zh ? '动态与记忆' : 'Activity & memory'}>{(['runs', 'memories'] as const).map(key => <button aria-pressed={tab === key} class={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{key === 'runs' ? (zh ? '动态' : 'Activity') : (zh ? '记忆' : 'Memory')}</button>)}</nav>
    {error && <p role="alert">{error}</p>}
    <div class="assistant-panel-list">{!data ? <div class="assistant-panel-empty">{error ? <button onClick={refresh}>{zh ? '重试' : 'Retry'}</button> : <LoaderCircle class="loading-spinner" />}</div> : tab === 'runs' ? <>
      {!!data.schedules?.length && <><h3>{zh ? '正在关注' : 'Following for you'}</h3>{data.schedules.map(schedule => <button key={schedule.id} class="assistant-record assistant-run" onClick={openSchedules}><span><strong>{schedule.name}</strong><small>{schedule.status === 'paused' ? (zh ? '已暂停' : 'Paused') : schedule.nextRunAt ? `${zh ? '下次' : 'Next'} · ${new Date(schedule.nextRunAt).toLocaleString(language, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : (zh ? '已完成' : 'Done')}</small></span><ChevronRight /></button>)}</>}
      {!!active.length && <><h3>{zh ? '正在进行中' : 'Ongoing'}</h3>{active.map(runRow)}</>}
      {!!recent.length && <><h3>{zh ? '最近' : 'Recent'}</h3>{recent.map(runRow)}</>}
      {!data.runs.length && !data.schedules?.length && <p class="assistant-panel-empty">{zh ? '有新进展时，会在这里留下记录。' : 'New activity will appear here.'}</p>}
    </> : data.memories.length ? data.memories.map(memory => <article key={memory.id} class="assistant-record assistant-memory">{editing === memory.id ? <div class="assistant-memory-editor"><textarea autoFocus value={text} maxLength={2000} onInput={event => setText(event.currentTarget.value)} /><div><button onClick={() => setEditing(undefined)}>{zh ? '取消' : 'Cancel'}</button><button class="assistant-save" disabled={!text.trim()} onClick={() => void update(memory.id)}>{zh ? '保存' : 'Save'}</button></div></div> : <><div class="assistant-memory-copy"><p>{memory.text}</p><small>{new Date(memory.updatedAt).toLocaleDateString(language, { month: 'short', day: 'numeric' })}</small></div><details class="assistant-memory-menu"><summary aria-label={zh ? '管理记忆' : 'Manage memory'}><MoreHorizontal /></summary><div><button onClick={() => openTask(memory.sourceTaskId)}><ArrowUpRight />{zh ? '查看来源' : 'View source'}</button><button onClick={() => { setEditing(memory.id); setText(memory.text) }}><Pencil />{zh ? '编辑' : 'Edit'}</button><button onClick={() => void update(memory.id, true)}><Trash2 />{zh ? '忘记' : 'Forget'}</button></div></details></>}</article>) : <p class="assistant-panel-empty">{zh ? '聊聊你的偏好，Shun 会慢慢记住。' : 'Shun will get to know your preferences as you talk.'}</p>}</div>
  </section></div>
}
