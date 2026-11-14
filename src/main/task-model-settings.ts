import type { Settings, Task } from '../shared.ts'

/** Resolve the same configured model limits for every task entry point. */
export function taskModelSettings(configured: Settings, task: Pick<Task, 'workspace' | 'model'>): Settings {
  const provider = configured.providers.find(item => item.id === configured.providerId) || configured.providers[0]
  if (!provider) throw Error('No model provider is configured for this task.')
  const modelId = task.model || configured.model
  if (!modelId) throw Error('No model is configured for this task.')
  const model = provider.models?.find(item => item.id === modelId)
  return { ...configured, providerId: provider.id, endpoint: provider.endpoint, apiKey: provider.apiKey,
    workspace: task.workspace, model: modelId,
    contextWindow: model?.contextWindow || provider.contextWindow || configured.contextWindow,
    maxTokens: model?.maxOutputTokens || configured.maxTokens }
}
