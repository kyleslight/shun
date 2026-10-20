import { createHash } from 'node:crypto'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

type Message = Record<string, any>
type Revision = { after: string; system?: Message; workspace?: Message; tools?: any[]; removed?: string[] }
export type ContextEncoding = {
  version: 1
  root: string
  system?: Message
  workspace?: Message
  tools?: any[]
  declarations: Record<string, Message[]>
  revisions: Revision[]
}

const entryType = 'shun:provider-context:v1'
const copy = <T>(value: T): T => structuredClone(value)
function canonical(value: any): string {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const declaration = (message: Message) => message?.role === 'system' && Array.isArray(message.tools)
const instruction = (message: Message) => message?.role === 'system' || message?.role === 'developer'
const nameOf = (tool: any): string => tool.function?.name || tool.custom?.name || tool.name
const toolList = (value: any) => Array.isArray(value) && value.every(tool => tool && typeof tool === 'object' && typeof nameOf(tool) === 'string')
function validEncoding(value: ContextEncoding | undefined): value is ContextEncoding {
  return Boolean(value?.version === 1 && typeof value.root === 'string'
    && (!value.system || instruction(value.system)) && (!value.workspace || instruction(value.workspace)) && (!value.tools || toolList(value.tools))
    && value.declarations && !Array.isArray(value.declarations)
    && Object.values(value.declarations).every(group => Array.isArray(group) && group.every(message => declaration(message) && toolList(message.tools)))
    && Array.isArray(value.revisions) && value.revisions.every(revision => revision && typeof revision.after === 'string'
      && (!revision.system || instruction(revision.system)) && (!revision.workspace || instruction(revision.workspace)) && (!revision.tools || toolList(revision.tools))
      && (!revision.removed || Array.isArray(revision.removed) && revision.removed.every(name => typeof name === 'string'))))
}
const revisionMessage = (revision: Revision): Message => ({ role: 'system', tools: copy(revision.tools || []),
  ...(revision.removed?.length ? { tools_remove: copy(revision.removed), content: `Unavailable tools: ${revision.removed.join(', ')}.` } : {}),
})
function registry(tools: any[], messages: Message[]): any[] {
  const current = new Map<string, any>()
  const add = (items: any[]) => {
    for (const tool of items) current.set(nameOf(tool), tool)
  }
  add(tools)
  for (const message of messages) if (declaration(message)) {
    for (const name of message.tools_remove || []) current.delete(name)
    add(message.tools)
  }
  return [...current.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
}

/** Provider encoding metadata only. The session remains the sole transcript and tool registry. */
export function encodeStableContext(payload: any, previous?: ContextEncoding, cwd?: string): { payload: any; encoding: ContextEncoding } {
  if (!Array.isArray(payload?.messages)) throw Error('This context encoding requires chat messages.')
  let incoming: Message[] = payload.messages
  // The resource loader supplies this exact footer from structured workspace state.
  // Keep it authoritative, but after the first user message: otherwise the provider
  // places the common tool schemas after a task-specific directory and cannot reuse them.
  // Existing encoded sessions keep their original wire prefix until a new epoch.
  const footer = cwd ? `Current working directory: ${cwd}\n` : ''
  const userIndex = incoming.findIndex(message => message.role === 'user')
  const sameEpoch = validEncoding(previous) && previous.root === hash(canonical(incoming.find(message => !instruction(message) && !declaration(message)) || null))
  const separate = footer && userIndex > 0 && instruction(incoming[0]) && typeof incoming[0]?.content === 'string'
    && incoming[0].content.endsWith(footer) && (!sameEpoch || Boolean(previous?.workspace))
  const workspace: Message | undefined = separate ? { role: 'system', content: footer } : undefined
  if (workspace) incoming = incoming.map((message, index) => index === 0
    ? { ...message, content: message.content.slice(0, -footer.length) } : message)
  const nodes = incoming.filter(message => !declaration(message))
  const first = instruction(nodes[0]) ? nodes[0] : undefined
  // A compacted or replaced history starts a new encoding epoch. Never replay
  // metadata from a different branch root into its instructions or tool list.
  const root = hash(canonical(nodes.find(message => !instruction(message)) || null))
  const encoding: ContextEncoding = validEncoding(previous) && previous.root === root && Boolean(previous.system) === Boolean(first) ? copy(previous) : {
    version: 1, root, system: copy(first), ...(workspace ? { workspace: copy(workspace) } : {}), tools: copy(payload.tools), declarations: {}, revisions: [],
  }
  const desiredTools = registry(payload.tools || [], incoming)
  const messages: Message[] = []
  let anchor = '', effectiveSystem = encoding.system, effectiveWorkspace = encoding.workspace
  for (let index = 0; index < incoming.length;) {
    const message = incoming[index++]
    if (declaration(message)) throw Error('A tool declaration must follow a conversation message.')
    const stable = messages.length === 0 && first ? encoding.system! : message
    anchor = hash(anchor + canonical(stable))
    messages.push(stable)
    if (index - 1 === userIndex && encoding.workspace) messages.push(copy(encoding.workspace))
    const current: Message[] = []
    while (index < incoming.length && declaration(incoming[index])) current.push(incoming[index++])
    if (current.length && !encoding.declarations[anchor]) encoding.declarations[anchor] = copy(current)
    // Deleting a tool must not delete its historical declaration from the wire.
    // Its current availability is replaced explicitly at the latest boundary.
    if (encoding.declarations[anchor]) messages.push(...copy(encoding.declarations[anchor]))
    for (const revision of encoding.revisions) if (revision.after === anchor) {
      if (revision.system) { messages.push(copy(revision.system)); effectiveSystem = revision.system }
      if (revision.workspace) { messages.push(copy(revision.workspace)); effectiveWorkspace = revision.workspace }
      if (revision.tools || revision.removed?.length) messages.push(revisionMessage(revision))
    }
  }
  const systemChanged = canonical(first) !== canonical(effectiveSystem)
  const workspaceChanged = workspace && canonical(workspace) !== canonical(effectiveWorkspace)
  const effective = new Map(registry(encoding.tools || [], messages).map(tool => [nameOf(tool), tool]))
  const desired = new Set(desiredTools.map(nameOf))
  const changed = desiredTools.filter(tool => canonical(tool) !== canonical(effective.get(nameOf(tool))))
  const removed = [...effective.keys()].filter(name => !desired.has(name))
  if (systemChanged || workspaceChanged || changed.length || removed.length) {
    const revision: Revision = { after: anchor, ...(systemChanged && first ? { system: copy(first) } : {}), ...(workspaceChanged ? { workspace: copy(workspace) } : {}), ...(changed.length || removed.length ? { tools: copy(changed), removed } : {}) }
    encoding.revisions.push(revision)
    if (revision.system) messages.push(copy(revision.system))
    if (revision.workspace) messages.push(copy(revision.workspace))
    if (revision.tools || revision.removed?.length) messages.push(revisionMessage(revision))
  }
  // Removal bookkeeping stays in the adapter. The provider receives only its
  // existing message/tool format and a small current-inventory notice.
  return { payload: { ...payload, tools: copy(encoding.tools), messages: messages.map(({ tools_remove: _, ...message }) => message) }, encoding }
}

/** Stable encoding for the explicitly configured message-scoped tool format. */
export const stableContextExtension: ExtensionFactory = api => {
  api.on('before_provider_request', (event, context) => {
    const entries = context.sessionManager.getBranch()
    const identity = `${context.model?.provider}/${context.model?.id}/${context.model?.baseUrl}`
    const saved = [...entries].reverse().find(entry => entry.type === 'custom' && entry.customType === entryType && (entry.data as any)?.identity === identity)
    const previous = saved?.type === 'custom' ? (saved.data as any)?.encoding as ContextEncoding : undefined
    const result = encodeStableContext(event.payload, previous, context.cwd)
    if (canonical(previous) !== canonical(result.encoding)) api.appendEntry(entryType, { identity, encoding: result.encoding })
    return result.payload
  })
}
