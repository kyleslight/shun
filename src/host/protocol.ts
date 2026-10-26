import type { AgentEvent, AttachmentRef, Provider, Settings, TaskEventEnvelope, ToolEvent, Turn } from '../shared.ts'
import { productToolPresentation, shellCommand } from '../tool-presentation.ts'

export const HOST_PROTOCOL = 2
export type HostTask = {
  hasMessages?: boolean
  archivedAt?: number
  lastActivityAt?: number
  contextWindow?: number
  maxTokens?: number
  id: string
  title: string
  workspace: string
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
}
export type HostSnapshot = {
  task: HostTask
  turns: Turn[]
  sequence: number
  activeRun?: string
  trustRequired: boolean
}
export type PublicProvider = Omit<Provider, 'apiKey'> & { hasKey: boolean }
export type HostConfiguration = {
  providers: PublicProvider[]
  providerId: string
  model: string
}
export type HostCall = (method: string, input?: Record<string, unknown>) => Promise<any>
export type HostState = { version: 1; settings: Settings; tasks: HostTask[] }

/** A UI projection of durable product events, never a second model transcript. */
export function applyHostEvent(turns: Turn[], envelope: TaskEventEnvelope): void {
  const payload = envelope.payload
  if (payload.type === 'request') {
    turns.push({ id: payload.messageId || payload.runId, role: 'user', content: payload.text, attachments: payload.attachments })
    turns.push({ id: payload.runId, role: 'assistant', content: '', startedAt: envelope.at, tools: [] })
    return
  }
  if (payload.type !== 'agent') return
  const turn = turns.find(item => item.id === payload.runId && item.role === 'assistant')
  if (!turn) return
  applyHostAgentEvent(turn, payload.event, envelope.at)
}

function applyHostAgentEvent(turn: Turn, event: AgentEvent, at: number) {
  if (event.type === 'delta') turn.content += event.text || ''
  if (event.type === 'phase') turn.phase = event.text
  if (event.type === 'context') turn.contextUsage = event.context
  if (event.type === 'tool' && event.tool) {
    const tools = turn.tools ||= []
    const index = tools.findIndex(item => item.id === event.tool!.id)
    if (index < 0) tools.push(event.tool)
    else tools[index] = event.tool
  }
  if (event.type === 'error') { turn.error = true; turn.content += `\n${event.text || 'The task failed.'}` }
  if (['done', 'error', 'cancelled'].includes(event.type)) {
    turn.completedAt = at
    turn.phase = event.type === 'cancelled' ? 'Stopped' : ''
  }
}

export function attachmentLabel(item: AttachmentRef) {
  return `${item.name}${item.width && item.height ? ` · ${item.width}×${item.height}` : ''}`
}

export function hostToolLabel(tool: ToolEvent) {
  const product = productToolPresentation(tool)
  if (product) return `${product.title}${product.detail ? ` · ${product.detail}` : ''}`
  const command = shellCommand(tool)
  if (command) return command
  let args: Record<string, unknown> = {}
  try { const parsed = JSON.parse(tool.input); if (parsed && !Array.isArray(parsed) && typeof parsed === 'object') args = parsed } catch {}
  const labels: Record<string, string> = { read: 'Read', write: 'Write', edit: 'Edit', grep: 'Search', find: 'Find', ls: 'List files' }
  const target = ['path', 'pattern', 'query', 'url'].map(key => args[key]).filter(value => typeof value === 'string').join(' · ')
  return `${labels[tool.name] || tool.name}${target ? ` · ${target}` : ''}`
}
