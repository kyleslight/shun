import type { BrowserAction, ChromeSnapshot } from './chrome-browser.ts'
import type { BrowserSession } from '../shared.ts'

export type BrowserFormField = { ref: string; action?: 'type' | 'select'; text?: string; value?: string; clear?: boolean }
type Frame = { session: BrowserSession; snapshot: ChromeSnapshot; text: string }
type Host = {
  snapshot(taskId: string, sessionId?: unknown, screenshot?: boolean): Promise<Frame>
  act(taskId: string, sessionId: unknown, action: BrowserAction): Promise<Frame>
}

/** Fill observed fields in one model turn; never click, press Enter, or submit. */
export async function fillBrowserForm(host: Host, taskId: string, sessionId: unknown, fields: BrowserFormField[] | undefined): Promise<Frame> {
  if (!Array.isArray(fields) || !fields.length || fields.length > 12) throw Error('Fill requires 1–12 observed form fields.')
  const refs = new Set<string>()
  for (const field of fields) {
    if (!/^[1-9]\d{0,11}$/.test(field.ref) || refs.has(field.ref)) throw Error('Fill requires distinct fresh numeric field refs.')
    refs.add(field.ref)
    if (field.action && !['type', 'select'].includes(field.action)) throw Error('Fill supports only type and select fields.')
    const value = field.action === 'select' ? field.value : field.text
    if (typeof value !== 'string' || value.length > (field.action === 'select' ? 2_000 : 20_000)) throw Error('Every field needs an explicit bounded value.')
  }
  let frame = await host.snapshot(taskId, sessionId, false)
  const url = frame.snapshot.tab?.url || frame.session.url
  const targets = fields.map(field => {
    const node = frame.snapshot.nodes?.find(node => String(node.ref) === field.ref)
    const roles = field.action === 'select' ? ['combobox', 'listbox'] : ['textbox', 'searchbox', 'spinbutton', 'combobox']
    if (!node || !roles.includes(String(node.role)) || node.disabled || node.readonly) throw Error('A fill target is missing or not an editable field. Read a fresh snapshot; no fields were changed.')
    return { ref: field.ref, role: node.role, name: node.name }
  })
  const completed: string[] = []
  const finish = (reason?: string, uncertain?: string, current = true): Frame => {
    let page: unknown
    try { page = JSON.parse(frame.text) } catch { page = frame.text }
    return { ...frame, text: JSON.stringify({ form: {
      status: reason ? 'stopped' : 'completed', completed_refs: completed,
      remaining_refs: fields.filter(field => !completed.includes(field.ref) && field.ref !== uncertain).map(field => field.ref),
      ...(reason ? { reason } : {}), ...(uncertain ? { uncertain_ref: uncertain } : {}),
      snapshot_current: current, submitted: false,
    }, page }) }
  }
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index], target = targets[index]
    const node = frame.snapshot.nodes?.find(node => String(node.ref) === field.ref)
    if ((frame.snapshot.tab?.url || frame.session.url) !== url) return finish('The page navigated. Inspect it before filling more fields.')
    if (!node || node.role !== target.role || node.name !== target.name || node.disabled || node.readonly) return finish('A field changed or disappeared. Inspect the fresh snapshot; completed fields were not repeated.')
    try {
      frame = await host.act(taskId, frame.session.id, field.action === 'select'
        ? { action: 'select', ref: field.ref, value: field.value }
        : { action: 'type', ref: field.ref, text: field.text, clear: field.clear !== false })
      completed.push(field.ref)
    } catch {
      // A lost response may follow a successful input. Never replay it or infer
      // that nothing happened: report the uncertain field separately.
      let current = true
      try { frame = await host.snapshot(taskId, frame.session.id, false) } catch { current = false }
      return finish('A field action did not return confirmation. Inspect before repeating any input.', field.ref, current)
    }
  }
  return finish()
}
