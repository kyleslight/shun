import type { BrowserSession } from '../shared.ts'

type TabMetadata = {
  id: number; title?: string; url?: string; active?: boolean; windowId?: number;
  openerTabId?: number; discarded?: boolean; frozen?: boolean; status?: string;
}

function locationSummary(value?: string): { origin?: string; path?: string; query_present?: boolean; fragment_present?: boolean } {
  try {
    const url = new URL(value || '')
    return { origin: url.origin, path: url.pathname, ...(url.search ? { query_present: true } : {}), ...(url.hash ? { fragment_present: true } : {}) }
  } catch { return {} }
}

/** Inventory is for choosing an existing tab, never for reconstructing an auth URL. */
export function browserTabMetadata(tab: TabMetadata) {
  return {
    id: tab.id, title: String(tab.title || '').slice(0, 200), ...locationSummary(tab.url),
    ...(tab.active ? { active: true } : {}), windowId: tab.windowId,
    ...(tab.openerTabId === undefined ? {} : { openerTabId: tab.openerTabId }),
    ...(tab.discarded || tab.status === 'unloaded' ? { render_state: 'unloaded' } : tab.frozen ? { render_state: 'frozen' } : tab.status === 'loading' ? { render_state: 'loading' } : {}),
  }
}

export function browserSessionMetadata(session: BrowserSession) {
  return { id: session.id, tabId: session.tabId, title: session.title.slice(0, 200), state: session.state, ...locationSummary(session.url) }
}
