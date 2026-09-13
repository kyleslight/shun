import assert from 'node:assert/strict'
import test from 'node:test'
import { satisfiesShunEngine, validateShunEngine } from './plugin-engines.ts'

test('engine ranges accept only the documented comparator subset', () => {
  assert.equal(validateShunEngine(undefined), undefined)
  assert.equal(validateShunEngine(''), undefined)
  assert.equal(validateShunEngine('*'), '*')
  assert.equal(validateShunEngine(' >=0.1.34 '), '>=0.1.34')
  assert.equal(validateShunEngine('^0.2.0'), '^0.2.0')
  assert.equal(validateShunEngine('~1.2.3'), '~1.2.3')
  assert.equal(validateShunEngine('>=0.1.0 <0.2.0'), '>=0.1.0 <0.2.0')
  assert.throws(() => validateShunEngine('>=0.1'), /full versions/)
  assert.throws(() => validateShunEngine('0.1.34'), /full versions/)
  assert.throws(() => validateShunEngine('>=0.1.0 || <0.2.0'), /full versions/)
  assert.throws(() => validateShunEngine('>=0.1.0 <0.2.0 >=1.0.0 <2.0.0 ~3.0.0'), /1-4 comparators/)
  assert.throws(() => validateShunEngine(`>=0.1.0${' '.repeat(60)}<1.0.0`), /at most 64 characters/)
})

test('engine ranges decide host compatibility with caret and tilde windows', () => {
  assert.equal(satisfiesShunEngine('0.1.34', undefined), true)
  assert.equal(satisfiesShunEngine('0.1.34', '*'), true)
  assert.equal(satisfiesShunEngine('0.1.34', '>=0.1.34'), true)
  assert.equal(satisfiesShunEngine('0.1.33', '>=0.1.34'), false)
  assert.equal(satisfiesShunEngine('0.2.0', '^0.2.0'), true)
  assert.equal(satisfiesShunEngine('0.3.0', '^0.2.0'), false)
  assert.equal(satisfiesShunEngine('1.9.9', '^1.2.0'), true)
  assert.equal(satisfiesShunEngine('2.0.0', '^1.2.0'), false)
  assert.equal(satisfiesShunEngine('1.2.9', '~1.2.3'), true)
  assert.equal(satisfiesShunEngine('1.3.0', '~1.2.3'), false)
  assert.equal(satisfiesShunEngine('0.0.3', '^0.0.3'), true)
  assert.equal(satisfiesShunEngine('0.0.4', '^0.0.3'), false)
  assert.equal(satisfiesShunEngine('0.2.5', '>=0.2.0 <0.3.0'), true)
  assert.equal(satisfiesShunEngine('0.3.1', '>=0.2.0 <0.3.0'), false)
  // A development build advertises the release it will become.
  assert.equal(satisfiesShunEngine('0.2.0-rc.1', '>=0.2.0'), true)
  assert.equal(satisfiesShunEngine('0.2.0-rc.1', '^0.2.0'), true)
  assert.equal(satisfiesShunEngine('not-a-version', '>=0.1.0'), false)
})
