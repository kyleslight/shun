import assert from 'node:assert/strict'
import test from 'node:test'
import { missingRelease, needsVersionPush, retrySync, transientFailure } from './release-resume.mjs'

test('a dropped connection is not an answer, and a real answer is not retried', () => {
  for (const message of [
    'Get "https://api.github.com/user": EOF',
    'Connection closed by UNKNOWN port 65535',
    'dial tcp: i/o timeout',
    'read: connection reset by peer',
    'proxyconnect tcp: dial tcp 127.0.0.1:7897: connect: connection refused',
    'HTTP 503: Service Unavailable',
    '', // nothing was said, so nothing was answered
  ]) assert.equal(transientFailure(message), true, message)

  for (const message of [
    'release not found',
    'gh: Not Found (HTTP 404)',
    '{"message":"Validation Failed","errors":[{"code":"already_exists"}]}',
  ]) assert.equal(transientFailure(message), false, message)
})

test('a failed release lookup is not read as a missing release', () => {
  assert.equal(missingRelease('release not found'), true)
  assert.equal(missingRelease('gh: Not Found (HTTP 404)'), true)
  // The failure that created a second draft for the same tag.
  assert.equal(missingRelease('Get "https://api.github.com/repos/x/y/releases/tags/v1.0.0": EOF'), false)
  assert.equal(missingRelease('Connection closed by UNKNOWN port 65535'), false)
})

test('a version commit the remote does not have is still owed a push', () => {
  assert.equal(needsVersionPush('c3882fa', '1072394'), true)
  assert.equal(needsVersionPush('c3882fa', 'c3882fa'), false)
  assert.equal(needsVersionPush('', ''), false)
  assert.equal(needsVersionPush('c3882fa', ''), true)
})

test('a transient failure is retried, and a decisive one is not', () => {
  let attempts = 0
  const recovered = retrySync(() => {
    attempts++
    if (attempts < 3) throw new Error('Get "https://api.github.com": EOF')
    return 'ok'
  }, { attempts: 5, onRetry: () => {} })
  assert.equal(recovered, 'ok')
  assert.equal(attempts, 3)

  const retried = []
  assert.throws(() => retrySync(() => { throw new Error('release not found') }, { attempts: 5, onRetry: (attempt, message) => retried.push([attempt, message]) }), /not found/)
  assert.deepEqual(retried, [], 'a decisive failure is surfaced at once instead of being repeated')

  let tries = 0
  assert.throws(() => retrySync(() => { tries++; throw new Error('EOF') }, { attempts: 3, onRetry: () => {} }), /EOF/)
  assert.equal(tries, 3, 'the last attempt surfaces the failure instead of hiding it')

  assert.equal(retrySync(() => 42), 42, 'a first-attempt success is returned as it is')
})
