import { browserControlNamesMatch } from './browser-control-name.ts'
import { browserNodeRef } from './browser-ref.ts'
import type { BrowserAction, ChromeSnapshot } from './chrome-browser.ts'
import type { BrowserSession } from '../shared.ts'

export type BrowserFormField = { ref: string; name?: string; action?: 'type' | 'select'; text?: string; value?: string; clear?: boolean }
type Frame = { session: BrowserSession; snapshot: ChromeSnapshot; text: string }
type Host = {
  snapshot(taskId: string, sessionId?: unknown, screenshot?: boolean): Promise<Frame>
  act(taskId: string, sessionId: unknown, action: BrowserAction): Promise<Frame>
  verifyField?(taskId: string, sessionId: unknown, ref: string, value: string): Promise<{ matches: boolean; invalid: boolean; selectionRequired: boolean }>
}

/** Fill observed fields in one model turn; never click, press Enter, or submit. */
export async function fillBrowserForm(host: Host, taskId: string, sessionId: unknown, fields: BrowserFormField[] | undefined): Promise<Frame> {
  if (!Array.isArray(fields) || !fields.length || fields.length > 12) throw Error('Fill requires 1–12 observed form fields.')
  fields = fields.map(field => {
    try { return { ...field, ref: browserNodeRef(field.ref) } }
    catch { throw Error('Fill requires distinct fresh field refs.') }
  })
  const refs = new Set<string>()
  for (const field of fields) {
    if (!/^(?:p:)?[1-9]\d{0,11}$/.test(field.ref) || refs.has(field.ref)) throw Error('Fill requires distinct fresh field refs.')
    refs.add(field.ref)
    if (field.action && !['type', 'select'].includes(field.action)) throw Error('Fill supports only type and select fields.')
    const value = field.action === 'select' ? field.value : field.text
    if (typeof value !== 'string' || value.length > (field.action === 'select' ? 2_000 : 20_000)) throw Error('Every field needs an explicit bounded value.')
  }
  let frame = await host.snapshot(taskId, sessionId, false)
  const url = frame.snapshot.tab?.url || frame.session.url
  const initialBindings = new Map((frame.snapshot.nodes || []).map(node => [String(node.ref), { role: node.role || '', name: node.name || '' }]))
  const completed: string[] = []
  const finish = (reason?: string, uncertain?: string, current = true): Frame => {
    let page: unknown
    try { page = JSON.parse(frame.text) } catch { page = frame.text }
    const requestedRemaining = fields.filter(field => !completed.includes(field.ref) && field.ref !== uncertain).map(field => field.ref)
    const currentNodes = new Map((frame.snapshot.nodes || []).map(node => [String(node.ref), node]))
    const samePage = (frame.snapshot.tab?.url || frame.session.url) === url
    const bound = (ref: string) => {
      const original = initialBindings.get(ref), node = currentNodes.get(ref)
      return Boolean(current && samePage && original && node && (node.role || '') === original.role && (node.name || '') === original.name)
    }
    const rebind = requestedRemaining.some(ref => !bound(ref)) || Boolean(uncertain && !bound(uncertain))
    return { ...frame, text: JSON.stringify({ form: {
      status: reason ? 'stopped' : 'completed', completed_refs: completed,
      remaining_refs: requestedRemaining.filter(bound),
      ...(rebind ? { rebind_required: true, remaining_requested_refs: requestedRemaining,
        ...(uncertain ? { uncertain_requested_ref: uncertain } : {}),
        ref_note: 'Requested refs are historical identifiers, not current action targets. Bind only from the current page returned here; inspect already-filled values and never replay uncertain input blindly.' } : {}),
      ...(reason ? { reason } : {}), ...(uncertain && bound(uncertain) ? { uncertain_ref: uncertain } : {}),
      snapshot_current: current, submitted: false,
    }, page }) }
  }
  if (fields.some(field => !frame.snapshot.nodes?.some(node => String(node.ref) === field.ref))) {
    return finish('The requested field refs changed before input. No fields were changed. Use the current page returned here to bind the fields again.')
  }
  const targets = fields.map(field => {
    const node = frame.snapshot.nodes!.find(node => String(node.ref) === field.ref)!
    const roles = field.action === 'select' ? ['combobox', 'listbox'] : ['textbox', 'searchbox', 'spinbutton', 'combobox']
    if (!roles.includes(String(node.role)) || node.disabled || node.readonly) throw Error('A fill target is not an editable field. No fields were changed.')
    if (field.name !== undefined && !browserControlNamesMatch(node.name || '', field.name)) throw Error(`Field [${field.ref}] changed its name or the supplied name does not match. Its observed name is ${node.name ? JSON.stringify(node.name) : 'empty; omit name for this field'}. Use the exact observed name, not its role. No fields were changed.`)
    return { ref: field.ref, role: node.role, name: node.name }
  })
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index], target = targets[index]
    const node = frame.snapshot.nodes?.find(node => String(node.ref) === field.ref)
    if ((frame.snapshot.tab?.url || frame.session.url) !== url) return finish('The page navigated. Inspect it before filling more fields.')
    if (!node || node.role !== target.role || node.name !== target.name || node.disabled || node.readonly) return finish('A field changed or disappeared. Inspect the fresh snapshot; completed fields were not repeated.')
    const before = frame.snapshot.nodes || []
    const expected = field.action === 'select' ? field.value
      : field.clear === false ? (typeof node.value === 'string' ? node.value + field.text : undefined) : field.text
    let inputStarted = false
    try {
      if (expected !== undefined && (host.verifyField || node.value === expected)) {
        const verified = await host.verifyField?.(taskId, frame.session.id, field.ref, expected)
        if (verified ? verified.matches && !verified.invalid && !verified.selectionRequired : !node.invalid && node.role !== 'combobox') {
          completed.push(field.ref)
          continue
        }
      }
      inputStarted = true
      frame = await host.act(taskId, frame.session.id, field.action === 'select'
        ? { action: 'select', ref: field.ref, value: field.value }
        : { action: 'type', ref: field.ref, text: field.text, clear: field.clear !== false })
      if ((frame.snapshot.tab?.url || frame.session.url) !== url) return finish('The page navigated. Inspect it before filling more fields.', field.ref)
      const actual = frame.snapshot.nodes?.find(node => String(node.ref) === field.ref)
      const verified = expected === undefined ? undefined : await host.verifyField?.(taskId, frame.session.id, field.ref, expected)
      if (!actual || actual.role !== target.role || actual.name !== target.name || expected === undefined || (verified ? !verified.matches : actual.value !== expected)) {
        return finish('The intended field value was not confirmed. Inspect its value, selected options, and validation errors before continuing; no remaining fields were filled.', field.ref)
      }
      if (verified?.selectionRequired) return finish('This autocomplete needs an explicit option selection. Read the fresh options and choose the intended one; typed text alone is not a committed selection.', field.ref)
      if (verified?.invalid || (actual.invalid && actual.invalid !== 'false')) return finish('The page reports this field as invalid. Inspect its validation message before continuing.', field.ref)
      const changedOtherField = before.some(previous => {
        if (String(previous.ref) === field.ref || !['textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox'].includes(previous.role)) return false
        const current = frame.snapshot.nodes?.find(node => node.ref === previous.ref)
        return current && current.value !== previous.value
      })
      if (changedOtherField) return finish('Another field changed during input. Inspect the form before continuing; no remaining fields were filled.', field.ref)
      completed.push(field.ref)
    } catch {
      // A lost response may follow a successful input. Never replay it or infer
      // that nothing happened: report the uncertain field separately.
      let current = true
      try { frame = await host.snapshot(taskId, frame.session.id, false) } catch { current = false }
      if (!inputStarted) return finish('Field verification did not respond. No input was sent to this field. Inspect Chrome’s native UI for a blocking prompt before continuing.', undefined, current)
      return finish('A field action did not return confirmation. Inspect before repeating any input.', field.ref, current)
    }
  }
  return finish()
}
