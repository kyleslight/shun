/**
 * What a paired phone is told about this machine's providers, and what it may
 * change.
 *
 * A provider is a connection: an endpoint, the key that opens it, and the
 * deployments it serves. The phone can choose one and edit its connection, so
 * the answer is shaped for that and nothing else — the key itself never leaves
 * this machine, only whether one is set.
 */
import type { Provider, ProviderApi, Settings } from './shared.ts'

export type RemoteProviderModel = {
  id: string
  name?: string
  contextWindow: number
  maxOutputTokens: number
}

export type RemoteProviderSummary = {
  id: string
  name: string
  kind: Provider['kind']
  api?: ProviderApi
  endpoint: string
  contextWindow: number
  /** The key stays here: a controller learns only that there is one. */
  hasApiKey: boolean
  models: RemoteProviderModel[]
}

export type RemoteProviderPatch = {
  id: string
  name?: string
  endpoint?: string
  api?: ProviderApi
  /** Absent keeps the stored key; an empty string removes it. */
  apiKey?: string
}

function providerModels(provider: Provider, fallbackWindow: number): RemoteProviderModel[] {
  const raw = Array.isArray(provider.models) ? provider.models : []
  return raw
    .map((item): RemoteProviderModel | null => {
      if (typeof item === 'string') {
        return {
          id: item,
          contextWindow: provider.contextWindow || fallbackWindow,
          maxOutputTokens: 8192,
        }
      }
      if (!item || typeof item !== 'object' || !item.id) return null
      return {
        id: String(item.id),
        ...(item.name ? { name: item.name } : {}),
        contextWindow: Number(item.contextWindow) || provider.contextWindow || fallbackWindow,
        maxOutputTokens: Number(item.maxOutputTokens) || 8192,
      }
    })
    .filter((model): model is RemoteProviderModel => model !== null)
}

export function remoteProviderSummary(provider: Provider, fallbackWindow: number): RemoteProviderSummary {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    ...(provider.api ? { api: provider.api } : {}),
    endpoint: provider.endpoint,
    contextWindow: provider.contextWindow || fallbackWindow,
    hasApiKey: Boolean(provider.apiKey),
    models: providerModels(provider, fallbackWindow),
  }
}

export function remoteProviders(settings: Settings): RemoteProviderSummary[] {
  return settings.providers.map(provider => remoteProviderSummary(provider, settings.contextWindow))
}

/**
 * Make one provider the one this machine runs with, keeping the model it is
 * already on when that provider serves it.
 */
export function selectRemoteProvider(settings: Settings, providerId: string): Settings | undefined {
  const provider = settings.providers.find(item => item.id === providerId)
  if (!provider) return undefined
  const models = providerModels(provider, settings.contextWindow)
  const model = models.find(item => item.id === settings.model) || models[0]
  return {
    ...settings,
    providerId: provider.id,
    endpoint: provider.endpoint,
    apiKey: provider.apiKey,
    model: model?.id || settings.model,
    contextWindow: model?.contextWindow || provider.contextWindow || settings.contextWindow,
    maxTokens: model?.maxOutputTokens || settings.maxTokens,
  }
}

/** Edit one provider's connection. The deployments it serves are left as they are. */
export function saveRemoteProvider(settings: Settings, patch: RemoteProviderPatch): Settings | undefined {
  const provider = settings.providers.find(item => item.id === patch.id)
  if (!provider) return undefined
  const name = patch.name?.trim()
  const endpoint = patch.endpoint?.trim()
  if (patch.name !== undefined && !name) return undefined
  if (patch.endpoint !== undefined && !endpoint) return undefined
  const next: Provider = {
    ...provider,
    ...(name ? { name } : {}),
    ...(endpoint ? { endpoint } : {}),
    ...(patch.api ? { api: patch.api } : {}),
    ...(patch.apiKey === undefined ? {} : { apiKey: patch.apiKey }),
  }
  const providers = settings.providers.map(item => item.id === provider.id ? next : item)
  return {
    ...settings,
    providers,
    // The active connection is read from the provider, so editing it while it is
    // the one in use has to move the copy at the top level too.
    ...(settings.providerId === provider.id ? { endpoint: next.endpoint, apiKey: next.apiKey } : {}),
  }
}
