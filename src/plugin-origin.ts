import type { PluginState } from './shared.ts'

export type PluginOrigin = 'builtin' | 'official' | 'community' | 'custom'

const builtInPlugins = new Set([
  'computer-use', 'browser-use', 'browser-preview', 'file-manager',
  'git-workbench', 'sites', 'terminal',
])

/** Labels describe authorship and origin, independently of installation state. */
export function pluginOrigin(plugin: Pick<PluginState, 'id' | 'source' | 'provenance'>): PluginOrigin {
  if (plugin.source === 'builtin') return builtInPlugins.has(plugin.id) ? 'builtin' : 'official'
  if (plugin.provenance?.source === 'marketplace') return plugin.provenance.official ? 'official' : 'community'
  return 'custom'
}

export function pluginOriginLabel(origin: PluginOrigin, zh = false) {
  const labels = {
    builtin: ['Built-in', '内置'],
    official: ['Official', '官方'],
    community: ['Community', '社区'],
    custom: ['Custom', '自建'],
  }
  return labels[origin][zh ? 1 : 0]
}
