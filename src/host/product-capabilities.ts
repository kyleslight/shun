import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defineTool, type ToolDefinition, type Skill } from '@earendil-works/pi-coding-agent'
import { Check } from 'typebox/value'
import type { DeferredTool } from '../main/agent-runtime.ts'
import type { HostCall } from './protocol.ts'
import { TaskRunRegistry } from '../main/task-runs.ts'

export const capabilityHome = (root: string) => join(root, 'desktop-capabilities')
export type CapabilityContext = { taskId: string; runId: string; cwd: string; workspace: string; model: string }
export type CapabilityCatalog = { tools: ToolDefinition[]; deferred: DeferredTool[]; skills: Skill[]; dispose?: () => Promise<void> }

/** The desktop owns connected resources; interfaces share its actual tool catalog. */
export class ProductCapabilityService {
  readonly runs = new TaskRunRegistry()
  private sessions = new Map<string, { context: CapabilityContext; catalog: CapabilityCatalog; controller: AbortController }>()
  private catalog: (context: CapabilityContext) => Promise<CapabilityCatalog>
  private conversations?: HostCall
  constructor(catalog: (context: CapabilityContext) => Promise<CapabilityCatalog>, conversations?: HostCall) { this.catalog = catalog; this.conversations = conversations }
  async initialize() {}
  async close() { for (const key of [...this.sessions.keys()]) await this.call('release', { key }) }
  async call(method: string, input: Record<string, any> = {}): Promise<any> {
    if (method.startsWith('conversation.') && this.conversations) return this.conversations(method.slice(13), input)
    if (method === 'open') {
      const context = input as CapabilityContext
      for (const key of ['taskId', 'runId', 'cwd', 'workspace', 'model'] as const) if (typeof context[key] !== 'string') throw Error('Invalid capability context.')
      const catalog = await this.catalog(context), key = randomUUID()
      this.sessions.set(key, { context, catalog, controller: new AbortController() })
      const deferred = new Map(catalog.deferred.map(item => [item.tool.name, item]))
      return { key, skills: catalog.skills, tools: catalog.tools.map(tool => ({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters, ...(deferred.has(tool.name) ? { ownerId: deferred.get(tool.name)!.ownerId, ownerName: deferred.get(tool.name)!.ownerName } : {}) })) }
    }
    const session = this.sessions.get(input.key)
    if (!session) throw Error('Shun capability session expired. Start a new turn to reconnect.')
    if (method === 'release') {
      session.controller.abort(); this.sessions.delete(input.key); await session.catalog.dispose?.(); return true
    }
    if (method !== 'execute') throw Error('Unknown capability method.')
    const tool = session.catalog.tools.find(item => item.name === input.name)
    if (!tool || !Check(tool.parameters, input.args)) throw Error('Invalid or unavailable Shun tool call.')
    return tool.execute(input.callId || randomUUID(), input.args, session.controller.signal, undefined, undefined as never)
  }
}

export async function connectProductCapabilities(call: HostCall, context: CapabilityContext) {
  const catalog = await call('open', context)
  const tools: ToolDefinition[] = catalog.tools.map((item: any) => defineTool({
    name: item.name, label: item.label, description: item.description, parameters: item.parameters,
    execute: async (callId, args, signal) => {
      const cancel = () => { void call('release', { key: catalog.key }).catch(() => {}) }
      if (signal?.aborted) throw Error('Task was stopped.')
      signal?.addEventListener('abort', cancel, { once: true })
      try { return await call('execute', { key: catalog.key, name: item.name, callId, args }) }
      finally { signal?.removeEventListener('abort', cancel) }
    },
  }))
  return {
    tools,
    deferred: catalog.tools.flatMap((item: any, index: number) => item.ownerId ? [{ ownerId: item.ownerId, ownerName: item.ownerName, tool: tools[index] }] : []) as DeferredTool[],
    skills: catalog.skills as Skill[],
    close: () => call('release', { key: catalog.key }),
  }
}
