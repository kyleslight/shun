import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { PluginConnectionState } from '../shared.ts'
import type { PluginSecretStore } from './plugin-secrets.ts'

type FetchLike = typeof fetch
type OpenExternal = (url: string) => Promise<unknown>

type GmailCredential = {
  clientId: string
  clientSecret?: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  account?: string
}

type GmailPart = {
  mimeType?: string
  filename?: string
  headers?: Array<{ name?: string; value?: string }>
  body?: { data?: string; attachmentId?: string; size?: number }
  parts?: GmailPart[]
}

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN = 'https://oauth2.googleapis.com/token'
const REVOKE = 'https://oauth2.googleapis.com/revoke'
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const MAX_OUTPUT = 30_000

export class GmailRestService {
  private readonly secrets: PluginSecretStore
  private readonly fetcher: FetchLike
  private readonly openExternal: OpenExternal

  constructor(secrets: PluginSecretStore, fetcher: FetchLike = fetch, openExternal: OpenExternal = async () => undefined) {
    this.secrets = secrets
    this.fetcher = fetcher
    this.openExternal = openExternal
  }

  async state(): Promise<PluginConnectionState> {
    if (!await this.readCredential()) return { connected: false, status: 'disconnected' }
    try {
      const profile = await this.authorizedJson('/profile')
      return connectedState(profile)
    } catch (error) {
      return { connected: false, status: 'error', message: gmailError(error) }
    }
  }

  async connect(clientJsonValue: unknown): Promise<PluginConnectionState> {
    try {
      const client = parseDesktopClient(clientJsonValue)
      const previous = await this.readCredential()
      const tokens = await authorizeDesktopClient(client, this.fetcher, this.openExternal)
      const refreshToken = String(tokens.refresh_token || (previous?.clientId === client.clientId ? previous.refreshToken : '')).trim()
      if (!refreshToken) throw Error('Google did not return offline access. Remove Shun from your Google Account connections, then authorize again.')
      const credential: GmailCredential = {
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        accessToken: requiredToken(tokens.access_token, 'access token'),
        refreshToken,
        expiresAt: Date.now() + clampInteger(tokens.expires_in, 60, 86_400, 3_600) * 1_000,
      }
      const profile = await this.requestJson('/profile', credential.accessToken)
      credential.account = String(profile?.emailAddress || '').trim() || undefined
      await this.writeCredential(credential)
      return connectedState(profile)
    } catch (error) {
      return { connected: false, status: 'error', message: gmailError(error) }
    }
  }

  async disconnect(): Promise<PluginConnectionState> {
    const credential = await this.readCredential()
    await this.secrets.delete('gmail')
    if (credential?.refreshToken) {
      const query = new URLSearchParams({ token: credential.refreshToken })
      await this.fetcher(`${REVOKE}?${query}`, { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
    }
    return { connected: false, status: 'disconnected', message: 'Gmail authorization removed from this device.' }
  }

  async labels() {
    const value = await this.authorizedJson('/labels')
    const labels = (Array.isArray(value?.labels) ? value.labels : []).map((label: any) => ({
      id: String(label?.id || ''), name: String(label?.name || ''), type: String(label?.type || ''),
    })).filter((label: any) => label.id && label.name)
    return boundedJson({ labels })
  }

  async messages(options: { query?: unknown; labelIds?: unknown; includeSpamTrash?: unknown; limit?: unknown } = {}) {
    const limit = clampInteger(options.limit, 1, 25, 10)
    const query = new URLSearchParams({ maxResults: String(limit) })
    optionalQuery(query, 'q', options.query, 1_000)
    for (const label of stringArray(options.labelIds, 20, 100, 'Gmail label ID')) query.append('labelIds', label)
    if (options.includeSpamTrash === true) query.set('includeSpamTrash', 'true')
    const listed = await this.authorizedJson(`/messages?${query}`)
    const ids: string[] = (Array.isArray(listed?.messages) ? listed.messages : []).slice(0, limit).map((item: any) => messageId(item?.id))
    const messages = await Promise.all(ids.map(id => this.authorizedJson(`/messages/${id}?${metadataQuery()}`)))
    return boundedJson({
      messages: messages.map(compactMessageMetadata),
      nextPageToken: String(listed?.nextPageToken || '') || undefined,
      resultSizeEstimate: Number(listed?.resultSizeEstimate || 0),
    })
  }

  async message(idValue: unknown) {
    const id = messageId(idValue)
    return boundedJson(compactFullMessage(await this.authorizedJson(`/messages/${id}?format=full`)))
  }

  async thread(idValue: unknown) {
    const id = messageId(idValue, 'thread')
    const value = await this.authorizedJson(`/threads/${id}?format=full`)
    return boundedJson({
      id: String(value?.id || id), historyId: String(value?.historyId || ''),
      messages: (Array.isArray(value?.messages) ? value.messages : []).slice(0, 40).map(compactFullMessage),
    })
  }

  async attachment(messageIdValue: unknown, attachmentIdValue: unknown, filenameValue: unknown) {
    const message = messageId(messageIdValue), attachment = attachmentId(attachmentIdValue)
    const filename = cleanFilename(filenameValue)
    const value = await this.authorizedJson(`/messages/${message}/attachments/${encodeURIComponent(attachment)}`)
    const data = String(value?.data || '')
    if (!data || data.length > 48 * 1024 * 1024) throw Error('Gmail attachment content is missing or too large.')
    const bytes = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw Error('Gmail attachment content is empty or exceeds the 32 MB import limit.')
    return { name: filename, bytes }
  }

  async modifyMessage(idValue: unknown, actionValue: unknown) {
    const id = messageId(idValue), action = String(actionValue || '').trim().toLowerCase()
    const changes: Record<string, { addLabelIds?: string[]; removeLabelIds?: string[] }> = {
      mark_read: { removeLabelIds: ['UNREAD'] },
      mark_unread: { addLabelIds: ['UNREAD'] },
      archive: { removeLabelIds: ['INBOX'] },
      star: { addLabelIds: ['STARRED'] },
      unstar: { removeLabelIds: ['STARRED'] },
    }
    const body = changes[action]
    if (!body && action !== 'trash' && action !== 'untrash') throw Error(`Unsupported Gmail message action: ${action || '(missing)'}`)
    const value = action === 'trash' || action === 'untrash'
      ? await this.authorizedJson(`/messages/${id}/${action}`, { method: 'POST' })
      : await this.authorizedJson(`/messages/${id}/modify`, { method: 'POST', body: JSON.stringify(body) })
    return boundedJson({ id: String(value?.id || id), threadId: String(value?.threadId || ''), labelIds: value?.labelIds || [], action })
  }

  async createDraft(input: MailInput) {
    const message = mailMessage(input)
    const value = await this.authorizedJson('/drafts', { method: 'POST', body: JSON.stringify({ message }) })
    return boundedJson({ id: String(value?.id || ''), message: compactMessageMetadata(value?.message || {}) })
  }

  async send(input: MailInput) {
    const value = await this.authorizedJson('/messages/send', { method: 'POST', body: JSON.stringify(mailMessage(input)) })
    return boundedJson({ id: String(value?.id || ''), threadId: String(value?.threadId || ''), labelIds: value?.labelIds || [], sent: true })
  }

  async sendDraft(idValue: unknown) {
    const id = messageId(idValue, 'draft')
    const value = await this.authorizedJson('/drafts/send', { method: 'POST', body: JSON.stringify({ id }) })
    return boundedJson({ id: String(value?.id || ''), threadId: String(value?.threadId || ''), labelIds: value?.labelIds || [], sent: true, draftId: id })
  }

  private async authorizedJson(path: string, init: RequestInit = {}) {
    let credential = await this.requireCredential()
    if (!credential.accessToken || credential.expiresAt <= Date.now() + 60_000) credential = await this.refreshCredential(credential)
    try { return await this.requestJson(path, credential.accessToken, init) }
    catch (error) {
      if (!/Gmail API 401:/.test(gmailError(error))) throw error
      credential = await this.refreshCredential(credential)
      return this.requestJson(path, credential.accessToken, init)
    }
  }

  private async requestJson(path: string, accessToken: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${accessToken}`)
    headers.set('accept', 'application/json')
    if (init.body) headers.set('content-type', 'application/json')
    const response = await this.fetcher(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) })
    const value = await responseValue(response)
    if (!response.ok) throw Error(`Gmail API ${response.status}: ${apiMessage(value, response.statusText)}`)
    return value
  }

  private async refreshCredential(credential: GmailCredential) {
    const body = new URLSearchParams({ client_id: credential.clientId, refresh_token: credential.refreshToken, grant_type: 'refresh_token' })
    if (credential.clientSecret) body.set('client_secret', credential.clientSecret)
    const response = await this.fetcher(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) })
    const value = await responseValue(response)
    if (!response.ok) throw Error(`Google OAuth ${response.status}: ${apiMessage(value, response.statusText)}`)
    const updated = {
      ...credential,
      accessToken: requiredToken(value?.access_token, 'access token'),
      expiresAt: Date.now() + clampInteger(value?.expires_in, 60, 86_400, 3_600) * 1_000,
    }
    await this.writeCredential(updated)
    return updated
  }

  private async requireCredential() {
    const credential = await this.readCredential()
    if (!credential) throw Error('Gmail is not connected. Authorize a Google account in Plugins.')
    return credential
  }

  private async readCredential(): Promise<GmailCredential | undefined> {
    const raw = await this.secrets.get('gmail')
    if (!raw) return undefined
    try {
      const value = JSON.parse(raw)
      if (!value?.clientId || !value?.refreshToken) return undefined
      return {
        clientId: String(value.clientId), clientSecret: value.clientSecret ? String(value.clientSecret) : undefined,
        accessToken: String(value.accessToken || ''), refreshToken: String(value.refreshToken), expiresAt: Number(value.expiresAt || 0),
        account: value.account ? String(value.account) : undefined,
      }
    } catch { return undefined }
  }

  private async writeCredential(value: GmailCredential) { await this.secrets.set('gmail', JSON.stringify(value)) }
}

export type MailInput = {
  to: unknown
  cc?: unknown
  bcc?: unknown
  subject: unknown
  body: unknown
  threadId?: unknown
  inReplyTo?: unknown
  references?: unknown
}

export function parseDesktopClient(value: unknown) {
  let parsed: any
  try { parsed = JSON.parse(String(value || '').trim()) } catch { throw Error('Paste a valid Google OAuth desktop client JSON file.') }
  const client = parsed?.installed
  const clientId = String(client?.client_id || '').trim(), clientSecret = String(client?.client_secret || '').trim()
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw Error('The OAuth JSON must contain an installed desktop client ID.')
  if (clientSecret && (clientSecret.length > 1_000 || /[\r\n]/.test(clientSecret))) throw Error('The OAuth desktop client secret is invalid.')
  return { clientId, clientSecret: clientSecret || undefined }
}

async function authorizeDesktopClient(client: ReturnType<typeof parseDesktopClient>, fetcher: FetchLike, openExternal: OpenExternal) {
  const verifier = base64Url(randomBytes(48)), challenge = base64Url(createHash('sha256').update(verifier).digest()), state = base64Url(randomBytes(24))
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port, redirectUri = `http://127.0.0.1:${port}`
  let cancelCallback = () => {}
  const callback = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Gmail authorization timed out.')), 5 * 60_000)
    cancelCallback = () => clearTimeout(timer)
    server.on('request', (request, response) => {
      const url = new URL(request.url || '/', redirectUri)
      response.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.searchParams.get('state') !== state) {
        response.statusCode = 400; response.end('<h1>Authorization failed</h1><p>Return to Shun and try again.</p>'); return
      }
      const error = url.searchParams.get('error'), code = url.searchParams.get('code')
      if (error || !code) {
        clearTimeout(timer); response.statusCode = 400; response.end('<h1>Authorization was not completed</h1><p>You can close this tab.</p>'); reject(Error(`Google authorization failed: ${error || 'missing code'}`)); return
      }
      clearTimeout(timer); response.end('<h1>Gmail connected</h1><p>You can close this tab and return to Shun.</p>'); resolve(code)
    })
  })
  const auth = new URL(AUTH)
  auth.search = new URLSearchParams({
    client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: challenge, code_challenge_method: 'S256',
  }).toString()
  try {
    await openExternal(auth.href)
    const code = await callback
    const body = new URLSearchParams({ client_id: client.clientId, code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    if (client.clientSecret) body.set('client_secret', client.clientSecret)
    const response = await fetcher(TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30_000) })
    const value = await responseValue(response)
    if (!response.ok) throw Error(`Google OAuth ${response.status}: ${apiMessage(value, response.statusText)}`)
    return value
  } finally { cancelCallback(); server.close() }
}

function connectedState(profile: any): PluginConnectionState {
  const account = String(profile?.emailAddress || '').trim()
  return { connected: true, status: 'connected', account, message: account ? `Connected to ${account}` : 'Gmail connected.' }
}

function metadataQuery() {
  const query = new URLSearchParams({ format: 'metadata' })
  for (const header of ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References']) query.append('metadataHeaders', header)
  return query
}

function compactMessageMetadata(value: any) {
  return {
    id: String(value?.id || ''), threadId: String(value?.threadId || ''), labelIds: Array.isArray(value?.labelIds) ? value.labelIds.map(String) : [],
    snippet: cleanText(value?.snippet, 500), internalDate: String(value?.internalDate || ''), sizeEstimate: Number(value?.sizeEstimate || 0),
    headers: selectedHeaders(value?.payload?.headers),
  }
}

function compactFullMessage(value: any) {
  const payload = value?.payload as GmailPart | undefined, content = extractContent(payload)
  return {
    ...compactMessageMetadata(value),
    body: cleanText(content.text || htmlToText(content.html), 20_000),
    attachments: content.attachments,
  }
}

function extractContent(part?: GmailPart) {
  const output: { text: string; html: string; attachments: Array<{ filename: string; mimeType: string; size: number; attachmentId: string }> } = { text: '', html: '', attachments: [] }
  const visit = (item?: GmailPart) => {
    if (!item) return
    const mimeType = String(item.mimeType || '').toLowerCase(), filename = String(item.filename || '').trim(), attachmentId = String(item.body?.attachmentId || '')
    if (filename || attachmentId) output.attachments.push({ filename: filename || 'attachment', mimeType: mimeType || 'application/octet-stream', size: Number(item.body?.size || 0), attachmentId })
    else if (item.body?.data && mimeType === 'text/plain') output.text += `${decodeBase64Url(item.body.data)}\n`
    else if (item.body?.data && mimeType === 'text/html') output.html += `${decodeBase64Url(item.body.data)}\n`
    for (const child of item.parts || []) visit(child)
  }
  visit(part)
  return output
}

function selectedHeaders(value: unknown) {
  const allowed = new Set(['from', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references'])
  return Object.fromEntries((Array.isArray(value) ? value : []).flatMap((item: any) => {
    const name = String(item?.name || '').trim(), key = name.toLowerCase()
    return allowed.has(key) ? [[name, cleanText(item?.value, 2_000)]] : []
  }))
}

function mailMessage(input: MailInput) {
  const to = emailList(input.to, true), cc = emailList(input.cc), bcc = emailList(input.bcc)
  const subject = headerValue(input.subject, 'subject', 998), body = String(input.body || '')
  if (!body.trim()) throw Error('Gmail message body is required.')
  if (body.length > 200_000) throw Error('Gmail message body is too long.')
  const headers = [
    `To: ${to.join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(', ')}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit',
  ]
  const inReplyTo = optionalHeader(input.inReplyTo, 'In-Reply-To'), references = optionalHeader(input.references, 'References')
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`)
  if (references) headers.push(`References: ${references}`)
  return { raw: base64Url(Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`)), ...(String(input.threadId || '').trim() ? { threadId: messageId(input.threadId, 'thread') } : {}) }
}

function emailList(value: unknown, required = false) {
  const values = stringArray(value, 50, 254, 'email address')
  if (required && !values.length) throw Error('At least one Gmail recipient is required.')
  for (const email of values) if (!/^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/.test(email)) throw Error(`Invalid Gmail recipient: ${email}`)
  return values
}

function stringArray(value: unknown, maxItems: number, maxLength: number, label: string) {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value) || value.length > maxItems) throw Error(`${label} values must be an array with at most ${maxItems} items.`)
  return value.map(item => String(item || '').trim()).filter(Boolean).map(item => {
    if (item.length > maxLength || /[\r\n\u0000]/.test(item)) throw Error(`Invalid ${label}.`)
    return item
  })
}

function headerValue(value: unknown, label: string, maxLength: number) {
  const text = String(value || '').trim()
  if (!text || text.length > maxLength || /[\r\n\u0000]/.test(text)) throw Error(`Gmail ${label} is required and must be a single header line.`)
  return text
}

function optionalHeader(value: unknown, label: string) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text.length > 2_000 || /[\r\n\u0000]/.test(text)) throw Error(`Invalid Gmail ${label} header.`)
  return text
}

function messageId(value: unknown, label = 'message') {
  const id = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{4,200}$/.test(id)) throw Error(`Enter a valid Gmail ${label} ID.`)
  return id
}

function attachmentId(value: unknown) {
  const id = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{4,2000}$/.test(id)) throw Error('Enter a valid Gmail attachment ID.')
  return id
}

function cleanFilename(value: unknown) {
  const name = String(value || '').trim().replace(/\\/g, '/').split('/').pop() || 'gmail-attachment'
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) throw Error('Enter a valid Gmail attachment filename.')
  return name
}

function optionalQuery(query: URLSearchParams, name: string, value: unknown, maxLength: number) {
  const text = String(value || '').trim()
  if (!text) return
  if (text.length > maxLength || /[\r\n\u0000]/.test(text)) throw Error(`Gmail ${name} query is invalid.`)
  query.set(name, text)
}

function cleanText(value: unknown, maxLength: number) {
  const text = String(value || '').replace(/\u0000/g, '').trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 20)}\n[truncated]`
}

function htmlToText(value: string) {
  return value.replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\n{3,}/g, '\n\n')
}

function decodeBase64Url(value: string) {
  try { return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') } catch { return '' }
}

function base64Url(value: Buffer) { return value.toString('base64url') }
function requiredToken(value: unknown, label: string) {
  const token = String(value || '').trim()
  if (!token || token.length > 8_000 || /[\r\n]/.test(token)) throw Error(`Google OAuth did not return a valid ${label}.`)
  return token
}
function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value)
  return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback
}
async function responseValue(response: Response) {
  const raw = await response.text()
  try { return raw ? JSON.parse(raw) : {} } catch { return raw }
}
function apiMessage(value: any, fallback: string) {
  const message = value?.error?.message || value?.error_description || value?.message || value?.error || value || fallback
  return String(message).slice(0, 1_000)
}
function boundedJson(value: unknown) {
  const output = JSON.stringify(value)
  return output.length <= MAX_OUTPUT ? output : `${output.slice(0, MAX_OUTPUT - 45)}\n[truncated by Gmail tool boundary]`
}
function gmailError(error: unknown) { return error instanceof Error ? error.message : String(error) }
