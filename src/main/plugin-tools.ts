import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { Settings } from '../shared.ts'
import type { PluginPackageRegistry } from './plugin-packages.ts'

/** Package-owned API entry points are registered from explicit installation state. */
export function packageAgentTools(registry: PluginPackageRegistry, settings: Settings, pluginIds: Set<string>, workspace: string, invoke: (pluginId: string, workerId: string, input: unknown) => Promise<unknown>): ToolDefinition[] {
  const available = () => registry.states(settings).filter(plugin => plugin.enabled && pluginIds.has(plugin.id)
    && (plugin.runtime?.workspace !== 'required' || Boolean(workspace))
    && plugin.permissions?.every(permission => settings.plugins?.find(item => item.id === plugin.id)?.permissions?.includes(permission.id)))
  return available().flatMap(plugin => (plugin.contributes?.tools || []).map(tool => defineTool({
    name: `plugin_${plugin.id.replaceAll('-', '_')}_${tool.id}`,
    label: tool.title,
    description: tool.description,
    parameters: Type.Object({
      operation: Type.String({ minLength: 1, maxLength: 100 }),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }, { additionalProperties: false }),
    execute: async (_id, args) => {
      const current = available().find(item => item.id === plugin.id)?.contributes?.tools?.find(item => item.id === tool.id)
      if (!current) throw Error('This plugin action is no longer available for the task.')
      const value = await invoke(plugin.id, current.worker, { operation: args.operation, input: args.input || {} })
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: { pluginId: plugin.id } }
    },
  })))
}
