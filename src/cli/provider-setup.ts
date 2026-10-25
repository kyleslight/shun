import type { ProviderCatalog } from '../shared.ts'
import type { HostCall, HostConfiguration } from '../host/protocol.ts'

type Choice = { value: string; label: string; description?: string }
export type SetupUI = {
  choose: (label: string, items: Choice[]) => Promise<string>
  ask: (label: string, initial?: string, secret?: boolean) => Promise<string>
}

/** Built-in connections own their defaults; only custom connections need a form. */
export async function setupProvider(call: HostCall, ui: SetupUI): Promise<string> {
  const catalog = await call('provider.catalog') as ProviderCatalog
  const config = await call('configuration') as HostConfiguration
  const choice = await ui.choose('Connect a provider · type to search', [
    ...catalog.providers.map(provider => ({ value: provider.id, label: provider.name,
      description: `API key${config.providers.some(item => item.catalogId === provider.id && item.hasKey) ? ' · configured' : ''}` })),
    { value: '__ollama__', label: 'Ollama', description: 'Local · no API key' },
    { value: '__lmstudio__', label: 'LM Studio', description: 'Local · no API key' },
    { value: '__custom__', label: 'Custom provider…', description: 'Use your own API base URL' },
  ])
  let input: Record<string, unknown>
  const preset = catalog.providers.find(item => item.id === choice)
  if (preset) {
    const variantId = preset.variants?.length ? await ui.choose(`${preset.name} · choose plan`, preset.variants.map(item => ({ value: item.id, label: item.label }))) : undefined
    const connection = preset.variants?.find(item => item.id === variantId) || preset
    const endpoint = connection.requiresEndpoint ? await ui.ask(`${preset.name} · API base URL`, connection.endpoint) : connection.endpoint
    let apiKey = ''
    while (!apiKey.trim()) apiKey = await ui.ask(`${preset.name} · ${connection.credentialLabel || preset.credentialLabel}\n${connection.authHelpUrl}\nPaste your key · Esc to cancel`, '', true)
    input = { catalogId: preset.id, variantId, endpoint, apiKey: apiKey.trim() }
  } else if (choice === '__ollama__' || choice === '__lmstudio__') {
    const local = choice === '__ollama__'
    input = { name: local ? 'Ollama' : 'LM Studio', endpoint: await ui.ask('Local server address', local ? 'http://localhost:11434/v1' : 'http://localhost:1234/v1'), api: 'openai-completions', apiKey: '' }
  } else {
    const name = await ui.ask('Custom provider name')
    const endpoint = await ui.ask('API base URL')
    const api = await ui.choose('Compatible API', [
      { value: 'openai-completions', label: 'OpenAI Chat Completions' },
      { value: 'openai-responses', label: 'OpenAI Responses' },
      { value: 'anthropic-messages', label: 'Anthropic Messages' },
      { value: 'google-generative-ai', label: 'Google Generative AI' },
    ])
    const apiKey = await ui.ask('API key · leave blank for an unauthenticated local server', '', true)
    input = { name, endpoint, api, apiKey }
  }
  const saved = await call('provider.save', input) as HostConfiguration
  return saved.providers.find(item => !config.providers.some(previous => previous.id === item.id))!.id
}
