import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserLinkReferences } from './browser-link.ts'

test('a mail link opens its exact observed destination without reconstructing a signed query', () => {
  const links = new BrowserLinkReferences()
  const url = `https://example.com/VerifyEmail?q=${'Ab%2BCd%2Fef='.repeat(60)}&next=%2Fa%3Fb%3D1`
  const document = JSON.parse(links.annotate(JSON.stringify({ links: [{ text: 'Verify', url }] })))
  assert.equal(document.links[0].url, url)
  assert.equal(links.resolve({ link_ref: document.links[0].link_ref }), url)
  assert.throws(() => links.resolve({ url, link_ref: document.links[0].link_ref }), /exactly one/)
  assert.throws(() => links.resolve({}), /exactly one/)
  assert.throws(() => new BrowserLinkReferences().resolve({ link_ref: document.links[0].link_ref }), /not available/)
})

test('link references are bounded and do not turn message prose or non-web links into actions', () => {
  const links = new BrowserLinkReferences(2)
  const doc = JSON.parse(links.annotate(JSON.stringify({ messages: [{ body: 'https://untrusted.example', links: [
    { url: 'https://example.com/first' }, { url: 'https://example.com/second' }, { url: 'https://example.com/third' }, { url: 'javascript:alert(1)' },
  ] }] })))
  const entries = doc.messages[0].links
  assert.throws(() => links.resolve({ link_ref: entries[0].link_ref }), /not available/)
  assert.equal(links.resolve({ link_ref: entries[1].link_ref }), entries[1].url)
  assert.equal(links.resolve({ link_ref: entries[2].link_ref }), entries[2].url)
  assert.equal(entries[3].link_ref, undefined)
  assert.equal(doc.messages[0].body, 'https://untrusted.example')
  assert.throws(() => links.resolve({ url: 'file:///private/example' }), /HTTP/)
  const truncated = '{"links": [truncated message'
  assert.equal(links.annotate(truncated), truncated)
})
