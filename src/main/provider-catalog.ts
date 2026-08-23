import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeProviderConnection, type ProviderApi, type ProviderCatalog, type ProviderCatalogEntry, type ProviderModel } from '../shared.ts'

type ModelsDevModel = {
  id?: string
  name?: string
  family?: string
  release_date?: string
  last_updated?: string
  reasoning?: boolean
  tool_call?: boolean
  status?: ProviderModel['status']
  limit?: { context?: number; output?: number }
  modalities?: { input?: string[]; output?: string[] }
}

type ModelsDevProvider = {
  id?: string
  name?: string
  api?: string
  models?: Record<string, ModelsDevModel>
}

type ProviderPreset = Omit<ProviderCatalogEntry, 'featuredModels' | 'models'> & {
  fallback: ProviderModel[]
}

const model = (id: string, name: string, contextWindow: number, maxOutputTokens: number, vision = true, reasoning = true): ProviderModel => ({
  id, name, contextWindow, maxOutputTokens, vision, reasoning, toolCall: true,
})

const presets: ProviderPreset[] = [
  {
    id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1', api: 'openai-responses',
    topLevel: true,
    credentialLabel: 'API key', credentialPlaceholder: 'sk-…',
    authHelpUrl: 'https://platform.openai.com/api-keys', authHelpLabel: 'Get API key',
    fallback: [
      model('gpt-5.6', 'GPT-5.6', 1_050_000, 128_000),
      model('gpt-5.3-codex', 'GPT-5.3 Codex', 400_000, 128_000),
      model('gpt-5.4-mini', 'GPT-5.4 mini', 400_000, 128_000),
      model('gpt-5.6-luna', 'GPT-5.6 Luna', 1_050_000, 128_000),
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic', endpoint: 'https://api.anthropic.com', api: 'anthropic-messages',
    topLevel: true,
    credentialLabel: 'API key', credentialPlaceholder: 'sk-ant-…',
    authHelpUrl: 'https://console.anthropic.com/settings/keys', authHelpLabel: 'Get API key',
    fallback: [
      model('claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000),
      model('claude-opus-5', 'Claude Opus 5', 1_000_000, 128_000),
      model('claude-fable-5', 'Claude Fable 5', 1_000_000, 128_000),
      model('claude-haiku-4-5', 'Claude Haiku 4.5', 200_000, 64_000),
    ],
  },
  {
    id: 'google', name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai',
    topLevel: true,
    credentialLabel: 'API key', credentialPlaceholder: 'AIza…',
    authHelpUrl: 'https://aistudio.google.com/apikey', authHelpLabel: 'Get API key',
    fallback: [
      model('gemini-3.6-flash', 'Gemini 3.6 Flash', 1_048_576, 65_536),
      model('gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 1_048_576, 65_536),
      model('gemini-3-flash-preview', 'Gemini 3 Flash Preview', 1_048_576, 65_536),
      model('gemini-3.1-flash-lite', 'Gemini 3.1 Flash Lite', 1_048_576, 65_536),
    ],
  },
  {
    id: 'xai', name: 'xAI · Grok', endpoint: 'https://api.x.ai/v1', api: 'openai-completions',
    topLevel: true,
    credentialLabel: 'API key', credentialPlaceholder: 'xai-…',
    authHelpUrl: 'https://console.x.ai/', authHelpLabel: 'Get API key',
    fallback: [
      model('grok-4.6', 'Grok 4.6', 500_000, 500_000),
      model('grok-4.5', 'Grok 4.5', 500_000, 500_000),
      model('grok-4.3', 'Grok 4.3', 1_000_000, 30_000),
      model('grok-build-0.1', 'Grok Build 0.1', 256_000, 256_000),
    ],
  },
  {
    id: 'xiaomi', name: 'Xiaomi MiMo', endpoint: 'https://api.xiaomimimo.com/v1', api: 'openai-completions',
    credentialLabel: 'API key', credentialPlaceholder: 'Xiaomi MiMo API key',
    authHelpUrl: 'https://platform.xiaomimimo.com/#/console/api-key', authHelpLabel: 'Get API key',
    variants: [
      {
        id: 'xiaomi-payg', name: 'Xiaomi MiMo', label: '按量', endpoint: 'https://api.xiaomimimo.com/v1',
        credentialPlaceholder: 'sk-…', authHelpUrl: 'https://platform.xiaomimimo.com/#/console/api-key', authHelpLabel: 'Get API key',
      },
      {
        id: 'xiaomi-token-plan', name: 'Xiaomi MiMo Token Plan', label: 'Token Plan', endpoint: '', requiresEndpoint: true,
        endpointPlaceholder: '从 Token Plan 页面复制 Base URL', credentialPlaceholder: 'tp-…',
        authHelpUrl: 'https://platform.xiaomimimo.com/token-plan', authHelpLabel: 'Open Token Plan',
      },
    ],
    fallback: [
      model('mimo-v2.5', 'MiMo-V2.5', 1_048_576, 131_072),
      model('mimo-v2.5-pro', 'MiMo-V2.5-Pro', 1_048_576, 131_072, false),
      model('mimo-v2.5-pro-ultraspeed', 'MiMo-V2.5-Pro-Ultraspeed', 1_048_576, 131_072, false),
      model('mimo-v2-omni', 'MiMo-V2-Omni', 262_144, 131_072),
    ],
  },
  {
    id: 'zai', name: '智谱 / Z.AI', endpoint: 'https://api.z.ai/api/paas/v4', api: 'openai-completions',
    topLevel: true,
    credentialLabel: 'API key', credentialPlaceholder: 'Z.AI API key',
    authHelpUrl: 'https://z.ai/manage-apikey/apikey-list', authHelpLabel: 'Get API key',
    variants: [
      {
        id: 'zhipu-cn', name: '智谱 AI（国内）', label: '国内', endpoint: 'https://open.bigmodel.cn/api/paas/v4',
        credentialPlaceholder: '智谱 API key', authHelpUrl: 'https://open.bigmodel.cn/usercenter/apikeys', authHelpLabel: 'Get API key',
      },
      {
        id: 'zai-global', name: 'Z.AI（海外）', label: '海外', endpoint: 'https://api.z.ai/api/paas/v4',
        credentialPlaceholder: 'Z.AI API key', authHelpUrl: 'https://z.ai/manage-apikey/apikey-list', authHelpLabel: 'Get API key',
      },
    ],
    fallback: [model('glm-5.2', 'GLM-5.2', 202_752, 131_072), model('glm-5.1', 'GLM-5.1', 202_752, 131_072), model('glm-5-turbo', 'GLM-5 Turbo', 202_752, 131_072), model('glm-4.7-flash', 'GLM-4.7 Flash', 202_752, 131_072)],
  },
  {
    id: 'moonshotai', name: 'Moonshot AI', endpoint: 'https://api.moonshot.ai/v1', api: 'openai-completions',
    topLevel: true,
    credentialLabel: 'API key', credentialPlaceholder: 'Moonshot API key',
    authHelpUrl: 'https://platform.kimi.ai/console/api-keys', authHelpLabel: 'Get API key',
    variants: [
      {
        id: 'moonshot-cn', name: 'Moonshot AI（国内）', label: '国内', endpoint: 'https://api.moonshot.cn/v1',
        credentialPlaceholder: 'Moonshot API key', authHelpUrl: 'https://platform.kimi.com/console/api-keys', authHelpLabel: 'Get API key',
      },
      {
        id: 'moonshot-global', name: 'Moonshot AI（海外）', label: '海外', endpoint: 'https://api.moonshot.ai/v1',
        credentialPlaceholder: 'Moonshot API key', authHelpUrl: 'https://platform.kimi.ai/console/api-keys', authHelpLabel: 'Get API key',
      },
    ],
    fallback: [model('kimi-k3', 'Kimi K3', 262_144, 65_536), model('kimi-k2.7-code', 'Kimi K2.7 Code', 262_144, 65_536), model('kimi-k2.6', 'Kimi K2.6', 262_144, 65_536), model('kimi-k2.5', 'Kimi K2.5', 262_144, 65_536)],
  },
  {
    id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com', api: 'openai-completions',
    topLevel: true,
    credentialLabel: 'API key', credentialPlaceholder: 'sk-…',
    authHelpUrl: 'https://platform.deepseek.com/api_keys', authHelpLabel: 'Get API key',
    fallback: [model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000, 384_000), model('deepseek-v4-flash', 'DeepSeek V4 Flash', 1_000_000, 384_000)],
  },
  {
    id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1', api: 'openai-completions',
    topLevel: true,
    credentialLabel: 'API key', credentialPlaceholder: 'sk-or-…',
    authHelpUrl: 'https://openrouter.ai/settings/keys', authHelpLabel: 'Get API key',
    fallback: [model('anthropic/claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000), model('openai/gpt-5.6', 'GPT-5.6', 1_050_000, 128_000), model('google/gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 1_048_576, 65_536), model('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', 1_000_000, 128_000)],
  },
  {
    id: 'minimax', name: 'MiniMax', endpoint: 'https://api.minimax.io/v1', api: 'openai-completions',
    credentialLabel: 'API key', credentialPlaceholder: 'MiniMax API key',
    authHelpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', authHelpLabel: 'Get API key',
    variants: [
      {
        id: 'minimax-cn', name: 'MiniMax（国内）', label: '国内', endpoint: 'https://api.minimaxi.com/v1',
        credentialPlaceholder: 'MiniMax API key', authHelpUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key', authHelpLabel: 'Get API key',
      },
      {
        id: 'minimax-global', name: 'MiniMax（海外）', label: '海外', endpoint: 'https://api.minimax.io/v1',
        credentialPlaceholder: 'MiniMax API key', authHelpUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key', authHelpLabel: 'Get API key',
      },
    ],
    fallback: [model('MiniMax-M3', 'MiniMax M3', 1_000_000, 128_000), model('MiniMax-M2.7', 'MiniMax M2.7', 204_800, 131_072, false), model('MiniMax-M2.7-highspeed', 'MiniMax M2.7 Highspeed', 204_800, 131_072, false)],
  },
  {
    id: 'groq', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1', api: 'openai-completions',
    credentialLabel: 'API key', credentialPlaceholder: 'gsk_…',
    authHelpUrl: 'https://console.groq.com/keys', authHelpLabel: 'Get API key',
    fallback: [model('openai/gpt-oss-120b', 'GPT OSS 120B', 131_072, 65_536, false), model('qwen/qwen3.6-27b', 'Qwen 3.6 27B', 131_072, 16_384), model('llama-3.3-70b-versatile', 'Llama 3.3 70B', 131_072, 32_768, false, false), model('openai/gpt-oss-20b', 'GPT OSS 20B', 131_072, 65_536, false)],
  },
  {
    id: 'nvidia', name: 'NVIDIA', endpoint: 'https://integrate.api.nvidia.com/v1', api: 'openai-completions',
    credentialLabel: 'API key', credentialPlaceholder: 'nvapi-…',
    authHelpUrl: 'https://build.nvidia.com/settings/api-keys', authHelpLabel: 'Get API key',
    fallback: [model('nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron 3 Ultra', 1_000_000, 65_536, false), model('nvidia/nemotron-3.5-lightning-30b-a3b', 'Nemotron 3.5 Lightning', 262_144, 262_144, false), model('nvidia/nemotron-3-super-120b-a12b', 'Nemotron 3 Super', 262_144, 262_144, false), model('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', 'Nemotron 3 Nano Omni', 256_000, 65_536)],
  },
  {
    id: 'amazon-bedrock', name: 'Amazon Bedrock', endpoint: '', endpointPlaceholder: 'https://bedrock-runtime.us-east-1.amazonaws.com', api: 'bedrock-converse-stream',
    credentialLabel: 'Bearer token', credentialPlaceholder: 'AWS bearer token', requiresEndpoint: true,
    authHelpUrl: 'https://docs.aws.amazon.com/bedrock/latest/userguide/security-iam.html', authHelpLabel: 'Authentication guide',
    fallback: [model('us.anthropic.claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000), model('us.anthropic.claude-opus-5', 'Claude Opus 5', 1_000_000, 128_000), model('openai.gpt-5.5', 'OpenAI GPT-5.5', 400_000, 128_000), model('zai.glm-5', 'GLM-5', 202_752, 131_072)],
  },
  {
    id: 'azure', name: 'Azure AI', endpoint: '', endpointPlaceholder: 'https://YOUR-RESOURCE.openai.azure.com/openai', api: 'azure-openai-responses',
    credentialLabel: 'API key', credentialPlaceholder: 'Azure API key', requiresEndpoint: true,
    authHelpUrl: 'https://learn.microsoft.com/azure/ai-foundry/openai/how-to/managed-identity', authHelpLabel: 'Authentication guide',
    fallback: [model('gpt-5.5', 'GPT-5.5', 400_000, 128_000), model('gpt-5.3-codex', 'GPT-5.3 Codex', 400_000, 128_000), model('gpt-5.4-mini', 'GPT-5.4 mini', 400_000, 128_000), model('claude-sonnet-5', 'Claude Sonnet 5', 1_000_000, 128_000)],
  },
]

const unsuitableModel = /(?:^|[-_/])(audio|embedding|image|moderation|realtime|speech|transcri|tts|veo|lyria)(?:[-_/]|$)/i
const datedSnapshot = /(?:^|[-_.])(?:20\d{6}|20\d{2}[-_]\d{2}[-_]\d{2}|\d{4})(?:$|[-_.])/i

function normalizeModel(id: string, raw: ModelsDevModel): ProviderModel | undefined {
  const contextWindow = Number(raw.limit?.context)
  const maxOutputTokens = Number(raw.limit?.output)
  if (!id || unsuitableModel.test(id) || raw.status === 'deprecated' || raw.tool_call === false || !contextWindow || !maxOutputTokens) return undefined
  if (raw.modalities?.output?.length && !raw.modalities.output.includes('text')) return undefined
  return {
    id,
    name: raw.name || id,
    family: raw.family,
    releaseDate: raw.release_date,
    lastUpdated: raw.last_updated,
    contextWindow,
    maxOutputTokens: Math.min(contextWindow, maxOutputTokens),
    vision: Boolean(raw.modalities?.input?.includes('image')),
    reasoning: Boolean(raw.reasoning),
    toolCall: true,
    status: raw.status,
  }
}

function recommendationScore(item: ProviderModel) {
  const date = Date.parse(item.lastUpdated || item.releaseDate || '') || 0
  const ageScore = date ? date / 86_400_000 : 0
  return ageScore
    + (item.status === 'deprecated' ? -20_000 : 0)
    + (datedSnapshot.test(item.id) ? -8_000 : 0)
    + (item.vision ? 0.6 : 0)
    + (item.reasoning ? 0.4 : 0)
    + Math.log2(Math.max(1, item.contextWindow)) * 0.01
}

/**
 * Pick a compact, self-updating default list without knowing model names ahead
 * of time. New stable releases naturally displace older models from the same
 * family while distinct general, coding, fast, and economical families remain
 * represented.
 */
export function recommendProviderModels(models: ProviderModel[], limit = 4) {
  const newestTimestamp = Math.max(0, ...models.map(item => Date.parse(item.lastUpdated || item.releaseDate || '') || 0)),
    recentWindowMs = 120 * 24 * 60 * 60 * 1_000,
    current = models.filter(item => {
      const timestamp = Date.parse(item.lastUpdated || item.releaseDate || '') || 0
      return item.status !== 'deprecated' && (!newestTimestamp || !timestamp || timestamp >= newestTimestamp - recentWindowMs)
    }),
    ranked = [...(current.length ? current : models)].sort((a, b) => recommendationScore(b) - recommendationScore(a))
  const selected: ProviderModel[] = [], families = new Set<string>()
  for (const item of ranked) {
    const family = item.family || item.id.toLowerCase().replace(/(?:[-_.](?:preview|latest|\d{4,8}))+$/g, '')
    if (families.has(family)) continue
    selected.push({ ...item, featured: true })
    families.add(family)
    if (selected.length === limit) break
  }
  for (const item of ranked) {
    if (selected.length === limit) break
    if (!selected.some(candidate => candidate.id === item.id)) selected.push({ ...item, featured: true })
  }
  return selected
}

export function normalizeModelsDevCatalog(input: unknown, now = Date.now()): ProviderCatalog {
  const map = input && typeof input === 'object' ? input as Record<string, ModelsDevProvider> : {}
  const providers = presets.map((preset): ProviderCatalogEntry => {
    const remote = map[preset.id]
    const remoteModels = Object.entries(remote?.models || {})
      .map(([key, value]) => normalizeModel(value.id || key, value))
      .filter((item): item is ProviderModel => Boolean(item))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id))
    const models = remoteModels.length ? remoteModels : preset.fallback
    const featuredModels = recommendProviderModels(models)
    return {
      id: preset.id,
      name: preset.name,
      endpoint: normalizeProviderConnection({ api: preset.api, endpoint: remote?.api || preset.endpoint }).endpoint,
      endpointPlaceholder: preset.endpointPlaceholder,
      api: preset.api,
      credentialLabel: preset.credentialLabel,
      credentialPlaceholder: preset.credentialPlaceholder,
      authHelpUrl: preset.authHelpUrl,
      authHelpLabel: preset.authHelpLabel,
      requiresEndpoint: preset.requiresEndpoint,
      topLevel: preset.topLevel,
      variants: preset.variants,
      featuredModels: featuredModels.length ? featuredModels : models.slice(0, 4),
      models,
    }
  })
  return { source: Object.keys(map).length ? 'models.dev' : 'fallback', updatedAt: now, providers }
}

export function reconcileProviderCatalog(catalog: ProviderCatalog): ProviderCatalog {
  const existing = new Map(catalog.providers.map(provider => [provider.id, provider]))
  const known = new Set(presets.map(preset => preset.id))
  const providers = presets.map((preset): ProviderCatalogEntry => {
    const current = existing.get(preset.id),
      models = current?.models?.length ? current.models : preset.fallback,
      featuredModels = recommendProviderModels(models)
    return {
      id: preset.id,
      name: preset.name,
      endpoint: normalizeProviderConnection({ api: preset.api, endpoint: current?.endpoint || preset.endpoint }).endpoint,
      endpointPlaceholder: preset.endpointPlaceholder,
      api: preset.api,
      credentialLabel: preset.credentialLabel,
      credentialPlaceholder: preset.credentialPlaceholder,
      authHelpUrl: preset.authHelpUrl,
      authHelpLabel: preset.authHelpLabel,
      requiresEndpoint: preset.requiresEndpoint,
      topLevel: preset.topLevel,
      variants: preset.variants,
      featuredModels: featuredModels.length ? featuredModels : models.slice(0, 4),
      models,
    }
  })
  return { ...catalog, providers: [...providers, ...catalog.providers.filter(provider => !known.has(provider.id))] }
}

type CatalogCacheFile = { fetchedAt: number; etag?: string; catalog: ProviderCatalog }

let cached: CatalogCacheFile | undefined
let inFlight: Promise<ProviderCatalog> | undefined
const CACHE_MS = 24 * 60 * 60 * 1_000

async function readCache(cacheFile?: string) {
  if (cached || !cacheFile) return cached
  try {
    const value = JSON.parse(await readFile(cacheFile, 'utf8')) as CatalogCacheFile
    if (value?.catalog?.providers?.length) cached = value
  } catch {}
  return cached
}

async function writeCache(cacheFile: string | undefined, value: CatalogCacheFile) {
  if (!cacheFile) return
  try {
    await mkdir(dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(value), 'utf8')
  } catch {}
}

export async function loadProviderCatalog(options: { request?: typeof fetch; cacheFile?: string; now?: number } = {}): Promise<ProviderCatalog> {
  const now = options.now ?? Date.now()
  let stored = await readCache(options.cacheFile)
  if (stored) {
    const catalog = reconcileProviderCatalog(stored.catalog)
    if (JSON.stringify(catalog.providers) !== JSON.stringify(stored.catalog.providers)) {
      stored = { ...stored, catalog }
      cached = stored
      await writeCache(options.cacheFile, stored)
    }
  }
  if (stored?.fetchedAt && now - stored.fetchedAt < CACHE_MS) return stored.catalog
  if (inFlight) return inFlight
  const coldStart = !stored
  if (!stored) {
    stored = { fetchedAt: 0, catalog: normalizeModelsDevCatalog({}, now) }
    cached = stored
  }
  inFlight = (async () => {
    try {
      const response = await (options.request || fetch)('https://models.dev/api.json', {
        headers: stored?.etag ? { 'if-none-match': stored.etag } : undefined,
        signal: AbortSignal.timeout(12_000),
      })
      if (response.status === 304 && stored) {
        const value = { ...stored, fetchedAt: now }
        cached = value
        await writeCache(options.cacheFile, value)
        return value.catalog
      }
      if (!response.ok) throw Error(`models.dev returned ${response.status}`)
      const catalog = normalizeModelsDevCatalog(await response.json(), now)
      const value = { fetchedAt: now, etag: response.headers.get('etag') || undefined, catalog }
      cached = value
      await writeCache(options.cacheFile, value)
      return catalog
    } catch {
      return stored?.catalog || normalizeModelsDevCatalog({}, now)
    } finally {
      inFlight = undefined
    }
  })()
  // Provider choices must never disappear behind a slow or unavailable
  // catalog request. Return the bundled snapshot immediately on a cold start;
  // a second caller can await the in-flight models.dev refresh.
  return coldStart ? stored.catalog : inFlight
}
