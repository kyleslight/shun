import assert from 'node:assert/strict'
import test from 'node:test'
import { oauthClientRegistration } from './oauth-clients.ts'

test('unregistered connectors have no bundled OAuth client', () => {
  assert.equal(oauthClientRegistration('figma'), undefined)
  assert.equal(oauthClientRegistration('cloudflare'), undefined)
  assert.equal(oauthClientRegistration(''), undefined)
})

test('a bundled Google registration comes from the build environment', () => {
  const idKey = 'SHUN_GOOGLE_OAUTH_CLIENT_ID', secretKey = 'SHUN_GOOGLE_OAUTH_CLIENT_SECRET'
  const previous = { id: process.env[idKey], secret: process.env[secretKey] }
  try {
    // A build without the variables ships no registration, and the Gmail plugin
    // asks the user for their own desktop client instead.
    delete process.env[idKey]
    delete process.env[secretKey]
    assert.equal(oauthClientRegistration('google'), undefined)

    process.env[idKey] = ' 618181389969-example.apps.googleusercontent.com '
    assert.deepEqual(oauthClientRegistration('google'), { clientId: '618181389969-example.apps.googleusercontent.com' })

    // The secret stays optional: PKCE alone is enough for the installed-app flow.
    process.env[secretKey] = ' GOCSPX-example '
    assert.deepEqual(oauthClientRegistration('google'), {
      clientId: '618181389969-example.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-example',
    })

    // Blank values are treated as absent rather than shipping an empty client.
    process.env[idKey] = '   '
    process.env[secretKey] = '   '
    assert.equal(oauthClientRegistration('google'), undefined)
  } finally {
    for (const [key, value] of [[idKey, previous.id], [secretKey, previous.secret]] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
