import type { Settings } from './shared.ts'

const keys = ['providers', 'providerId', 'model', 'endpoint', 'apiKey', 'contextWindow', 'maxTokens'] as const
export type ProviderSettings = Pick<Settings, typeof keys[number]>
export function providerSettings(settings: Settings): ProviderSettings {
  return Object.fromEntries(keys.map(key => [key, settings[key]])) as ProviderSettings
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Apply only the fields this client changed since its last view of the shared settings. */
export function mergeProviderSettings(current: ProviderSettings, next: ProviderSettings, base: ProviderSettings): ProviderSettings {
  const result = structuredClone(current)
  for (const key of keys) {
    if (key === 'providers' || same(next[key], base[key])) continue
    ;(result as any)[key] = next[key]
  }
  const held = new Map(current.providers.map(item => [item.id, item]))
  for (const old of base.providers) if (!next.providers.some(item => item.id === old.id)) held.delete(old.id)
  for (const item of next.providers) {
    const old = base.providers.find(value => value.id === item.id)
    if (same(item, old)) continue
    if (!old) { held.set(item.id, item); continue }
    const latest = held.get(item.id)
    if (!latest) continue // An untouched stale view must not resurrect a removed connection.
    const updated = { ...latest }
    for (const key of new Set([...Object.keys(old), ...Object.keys(item)])) {
      if (!same((old as any)[key], (item as any)[key])) (updated as any)[key] = (item as any)[key]
    }
    held.set(item.id, updated)
  }
  result.providers = [...held.values()]
  const selected = result.providers.find(item => item.id === result.providerId)
  if (selected) { result.endpoint = selected.endpoint; result.apiKey = selected.apiKey }
  else { result.providerId = ''; result.model = ''; result.endpoint = ''; result.apiKey = '' }
  return result
}


/** Resolve a conversation's selected deployment before provider-wide defaults. */
export function modelLimits(settings: ProviderSettings, providerId: string, modelId: string) {
  const provider = settings.providers.find(item => item.id === providerId)
  const model = provider?.models?.find(item => item.id === modelId)
  const selected = settings.providerId === providerId && settings.model === modelId
  const contextWindow = model?.contextWindow || (selected && settings.contextWindow) || provider?.contextWindow || 32768
  const maxTokens = Math.min(contextWindow, model?.maxOutputTokens || settings.maxTokens || 8192)
  return { contextWindow, maxTokens }
}
