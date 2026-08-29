import type { PluginViewDescriptor } from '../../shared'

export type PluginViewRecents = Record<string, string[]>

const maxRecentViewsPerWorkspace = 8
const maxRecentWorkspaces = 24

export function pluginViewKey(view: Pick<PluginViewDescriptor, 'pluginId' | 'viewId'>) {
  return `${view.pluginId}:${view.viewId}`
}

export function parsePluginViewRecents(value: string | null): PluginViewRecents {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed)
      .filter(([workspace, ids]) => Boolean(workspace) && Array.isArray(ids))
      .slice(0, maxRecentWorkspaces)
      .map(([workspace, ids]) => [workspace, [...new Set((ids as unknown[]).filter((id): id is string => typeof id === 'string' && id.includes(':')))].slice(0, maxRecentViewsPerWorkspace)]))
  } catch {
    return {}
  }
}

export function rememberPluginView(recents: PluginViewRecents, workspace: string, view: Pick<PluginViewDescriptor, 'pluginId' | 'viewId'>): PluginViewRecents {
  if (!workspace) return recents
  const key = pluginViewKey(view), current = recents[workspace] || []
  const next = [key, ...current.filter(id => id !== key)].slice(0, maxRecentViewsPerWorkspace)
  if (next.length === current.length && next.every((id, index) => id === current[index])) return recents
  return { ...recents, [workspace]: next }
}

export function prunePluginViewRecents(recents: PluginViewRecents, views: PluginViewDescriptor[]): PluginViewRecents {
  const available = new Set(views.map(pluginViewKey)), next: PluginViewRecents = {}
  for (const [workspace, ids] of Object.entries(recents)) {
    const kept = ids.filter(id => available.has(id)).slice(0, maxRecentViewsPerWorkspace)
    if (kept.length) next[workspace] = kept
  }
  return JSON.stringify(next) === JSON.stringify(recents) ? recents : next
}

export function pluginRailViewsForWorkspace(views: PluginViewDescriptor[], workspace: string, recents: PluginViewRecents) {
  const recent = new Set(workspace ? recents[workspace] || [] : [])
  return views.filter(view =>
    view.launch.includes('user') &&
    (view.workspace !== 'required' || Boolean(workspace)) &&
    (view.rail === 'workspace' || (view.rail === 'on-demand' && recent.has(pluginViewKey(view))))
  )
}
