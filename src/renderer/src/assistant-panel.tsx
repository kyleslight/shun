import { useEffect, useState } from 'preact/hooks'
import type { AssistantOverview } from '../../shared'
import './assistant-panel.css'

export function AssistantPanel({ language, close, openTask }: { language: string; close: () => void; openTask: (id: string) => void }) {
  const zh = language.startsWith('zh')
  const [data, setData] = useState<AssistantOverview>()
  const [tab, setTab] = useState<'memories' | 'runs'>('runs')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<string>()
  const [text, setText] = useState('')
  const refresh = () => window.shun.assistantOverview().then(setData).catch(error => setError(error.message))
  useEffect(() => { void refresh() }, [])
  const update = async (id: string, remove = false) => {
    try { await window.shun.assistantMemoryUpdate({ id, text, remove }); setEditing(undefined); await refresh() }
    catch (error) { setError(String(error)) }
  }
  return <div class="assistant-panel-backdrop" onClick={close}><section class="assistant-panel" role="dialog" aria-label={zh ? '记忆与动态' : 'Memory & activity'} onClick={event => event.stopPropagation()}>
    <header><h2>{zh ? '记忆与动态' : 'Memory & activity'}</h2><button onClick={close} aria-label={zh ? '关闭' : 'Close'}>×</button></header>
    <nav>{(['runs', 'memories'] as const).map(key => <button class={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{key === 'runs' ? (zh ? '运行记录' : 'Activity') : (zh ? '记忆' : 'Memory')}</button>)}</nav>
    {error && <p role="alert">{error}</p>}
    <div class="assistant-panel-list">{!data ? <p>{zh ? '正在加载…' : 'Loading…'}</p> : tab === 'runs' ? data.runs.length ? data.runs.map(run => <button class="assistant-record" onClick={() => openTask(run.id)}><strong>{run.title}</strong><small>{new Date(run.updatedAt).toLocaleString()} · {run.status === 'running' ? (zh ? '进行中' : 'Running') : run.status === 'error' ? (zh ? '未完成' : 'Failed') : (zh ? '已完成' : 'Completed')}{run.background ? ` · ${zh ? '后台检查' : 'Background check'}` : ''}</small></button>) : <p>{zh ? '后台检查和委派任务的记录会出现在这里。' : 'Background checks and delegated tasks will appear here.'}</p> : data.memories.length ? data.memories.map(memory => <article class="assistant-record">{editing === memory.id ? <><textarea value={text} maxLength={2000} onInput={event => setText(event.currentTarget.value)} /><button onClick={() => void update(memory.id)}>{zh ? '保存' : 'Save'}</button><button onClick={() => setEditing(undefined)}>{zh ? '取消' : 'Cancel'}</button></> : <><p>{memory.text}</p><small>{memory.scope} · {new Date(memory.updatedAt).toLocaleDateString()}</small><div class="assistant-memory-actions"><button onClick={() => openTask(memory.sourceTaskId)}>{zh ? '来源' : 'Source'}</button><button onClick={() => { setEditing(memory.id); setText(memory.text) }}>{zh ? '编辑' : 'Edit'}</button><button onClick={() => void update(memory.id, true)}>{zh ? '忘记' : 'Forget'}</button></div></>}</article>) : <p>{zh ? '告诉 Shun「记住……」，可以在这里查看和编辑。' : 'Ask Shun to remember something. You can review and edit it here.'}</p>}</div>
  </section></div>
}
