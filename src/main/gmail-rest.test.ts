import assert from 'node:assert/strict'
import test from 'node:test'
import { GmailRestService, parseDesktopClient } from './gmail-rest.ts'
import { MemoryPluginSecretStore } from './plugin-secrets.ts'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

async function configuredStore(expiresAt = Date.now() + 60 * 60_000) {
  const store = new MemoryPluginSecretStore()
  await store.set('gmail', JSON.stringify({
    clientId: 'client.apps.googleusercontent.com', clientSecret: 'client-secret', accessToken: 'access-token', refreshToken: 'refresh-token', expiresAt,
  }))
  return store
}

test('Gmail accepts only Google OAuth desktop client JSON', () => {
  assert.deepEqual(parseDesktopClient(JSON.stringify({ installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 'secret' } })), {
    clientId: 'abc.apps.googleusercontent.com', clientSecret: 'secret',
  })
  assert.throws(() => parseDesktopClient('{"web":{"client_id":"abc.apps.googleusercontent.com"}}'), /installed desktop client ID/i)
  assert.throws(() => parseDesktopClient('not json'), /valid Google OAuth desktop client JSON/i)
})

test('Gmail without OAuth state is neutrally disconnected', async () => {
  const service = new GmailRestService(new MemoryPluginSecretStore(), async () => { throw Error('must not fetch') })
  assert.deepEqual(await service.state(), { connected: false, status: 'disconnected' })
})

test('Gmail desktop OAuth uses PKCE and retains encrypted-store tokens only after profile verification', async () => {
  const store = new MemoryPluginSecretStore(), requests: string[] = []
  const service = new GmailRestService(store, async (input, init) => {
    const url = String(input); requests.push(url)
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = init?.body as URLSearchParams
      assert.equal(body.get('code'), 'authorization-code')
      assert.ok(body.get('code_verifier'))
      return json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600 })
    }
    assert.equal(url, 'https://gmail.googleapis.com/gmail/v1/users/me/profile')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-access')
    return json({ emailAddress: 'user@example.com' })
  }, async authUrl => {
    const auth = new URL(authUrl)
    assert.equal(auth.origin, 'https://accounts.google.com')
    assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.modify')
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    assert.ok(auth.searchParams.get('code_challenge'))
    const callback = new URL(auth.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', auth.searchParams.get('state')!)
    callback.searchParams.set('code', 'authorization-code')
    const response = await fetch(callback)
    assert.equal(response.status, 200)
  })

  const state = await service.connect(JSON.stringify({ installed: { client_id: 'client.apps.googleusercontent.com', client_secret: 'client-secret' } }))
  assert.deepEqual(state, { connected: true, status: 'connected', account: 'user@example.com', message: 'Connected to user@example.com' })
  assert.deepEqual(requests, ['https://oauth2.googleapis.com/token', 'https://gmail.googleapis.com/gmail/v1/users/me/profile'])
  const stored = await store.get('gmail')
  assert.match(stored || '', /secret-refresh/)
  assert.doesNotMatch(JSON.stringify(state), /secret-access|secret-refresh|client-secret/)
})

test('Gmail refreshes expired OAuth access and returns hydrated bounded search results', async () => {
  const store = await configuredStore(0), seen: string[] = []
  const service = new GmailRestService(store, async (input, init) => {
    const url = String(input); seen.push(url)
    if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'refreshed-access', expires_in: 3600 })
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer refreshed-access')
    if (url.includes('/messages?')) return json({ messages: [{ id: '18abc123' }], resultSizeEstimate: 1 })
    return json({
      id: '18abc123', threadId: '18thread1', labelIds: ['INBOX', 'UNREAD'], snippet: 'Quarterly update', internalDate: '1700000000000',
      payload: { headers: [{ name: 'From', value: 'Alice <alice@example.com>' }, { name: 'Subject', value: 'Quarterly update' }, { name: 'X-Secret', value: 'omit' }] },
    })
  })

  const output = await service.messages({ query: 'is:unread from:alice@example.com', limit: 5 })
  assert.match(output, /Quarterly update/)
  assert.match(output, /Alice <alice@example.com>/)
  assert.doesNotMatch(output, /X-Secret|omit/)
  assert.ok(seen.some(url => url.includes('q=is%3Aunread\+from%3Aalice%40example.com')))
  assert.match(await store.get('gmail') || '', /refreshed-access/)
})

test('Gmail reads multipart text, exposes attachment metadata, and never returns encoded bodies', async () => {
  const store = await configuredStore()
  const service = new GmailRestService(store, async input => {
    assert.match(String(input), /\/messages\/18abc123\?format=full$/)
    return json({
      id: '18abc123', threadId: '18thread1', snippet: 'Hello',
      payload: {
        headers: [{ name: 'From', value: 'alice@example.com' }, { name: 'Subject', value: 'Hello' }],
        parts: [
          { mimeType: 'text/plain', body: { data: Buffer.from('Hello from Gmail.').toString('base64url') } },
          { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'attach_1', size: 2048 } },
        ],
      },
    })
  })
  const output = await service.message('18abc123')
  assert.match(output, /Hello from Gmail/)
  assert.match(output, /report\.pdf/)
  assert.match(output, /attach_1/)
  assert.doesNotMatch(output, new RegExp(Buffer.from('Hello from Gmail.').toString('base64url')))
})

test('Gmail attachments decode only explicit bounded message attachment identities', async () => {
  const store = await configuredStore()
  const service = new GmailRestService(store, async input => {
    assert.match(String(input), /\/messages\/18abc123\/attachments\/attach_1$/)
    return json({ size: 6, data: Buffer.from('report').toString('base64url') })
  })
  const attachment = await service.attachment('18abc123', 'attach_1', '../report.txt')
  assert.equal(attachment.name, 'report.txt')
  assert.equal(attachment.bytes.toString(), 'report')
  await assert.rejects(() => service.attachment('18abc123', 'bad/id', 'report.txt'), /valid Gmail attachment ID/)
})

test('Gmail sending validates recipients and emits a bounded RFC 822 message only on explicit tool use', async () => {
  const store = await configuredStore(), rawMessages: string[] = []
  const service = new GmailRestService(store, async (_input, init) => {
    const body = JSON.parse(String(init?.body || '{}'))
    rawMessages.push(Buffer.from(body.raw, 'base64url').toString('utf8'))
    return json({ id: '18sent123', threadId: '18thread1', labelIds: ['SENT'] })
  })

  const output = await service.send({ to: ['alice@example.com'], subject: '你好', body: 'Confirmed.' })
  assert.match(output, /"sent":true/)
  assert.match(rawMessages[0], /^To: alice@example\.com\r\n/)
  assert.match(rawMessages[0], /Subject: =\?UTF-8\?B\?/)
  assert.match(rawMessages[0], /\r\n\r\nConfirmed\.$/)
  await assert.rejects(() => service.send({ to: ['not-an-email'], subject: 'Hello', body: 'Body' }), /Invalid Gmail recipient/)
})

test('Gmail message updates expose reversible actions and reject unknown mutations', async () => {
  const store = await configuredStore(), requests: Array<{ url: string; body?: unknown }> = []
  const service = new GmailRestService(store, async (input, init) => {
    requests.push({ url: String(input), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    return json({ id: '18abc123', threadId: '18thread1', labelIds: [] })
  })
  assert.match(await service.modifyMessage('18abc123', 'archive'), /"action":"archive"/)
  assert.match(await service.modifyMessage('18abc123', 'trash'), /"action":"trash"/)
  assert.deepEqual(requests, [
    { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/18abc123/modify', body: { removeLabelIds: ['INBOX'] } },
    { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/18abc123/trash' },
  ])
  await assert.rejects(() => service.modifyMessage('18abc123', 'delete'), /Unsupported Gmail message action/)
})
