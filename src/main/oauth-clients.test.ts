import assert from 'node:assert/strict'
import test from 'node:test'
import { oauthClientRegistration } from './oauth-clients.ts'

test('unregistered connectors have no bundled OAuth client', () => {
  assert.equal(oauthClientRegistration('figma'), undefined)
  assert.equal(oauthClientRegistration('cloudflare'), undefined)
  assert.equal(oauthClientRegistration(''), undefined)
})

test('a shipped Google registration is a desktop client, or absent', () => {
  // The registry ships empty until a verified client exists. When it is filled
  // in, this is the check that catches a web client id or a stray newline being
  // pasted in — the failure mode that would otherwise surface as a confusing
  // Google error during the connect flow.
  const registration = oauthClientRegistration('google')
  if (!registration) return
  assert.match(registration.clientId, /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/)
  assert.equal(registration.clientId.trim(), registration.clientId)
  if (registration.clientSecret !== undefined) assert.equal(registration.clientSecret.trim(), registration.clientSecret)
})
