import assert from 'node:assert/strict'
import test from 'node:test'
import { browserControlNamesMatch } from './browser-control-name.ts'

test('a control name accepts the same label without private font icon glyphs', () => {
  assert.equal(browserControlNamesMatch('\uf011 Logout', 'Logout'), true)
  assert.equal(browserControlNamesMatch(' Save \ue001 ', 'Save'), true)
  assert.equal(browserControlNamesMatch('Account\u{f0001}', 'Account'), true)
  assert.equal(browserControlNamesMatch('提交', '提交'), true)
})

test('font icon tolerance never matches a different textual control or invents an icon label', () => {
  assert.equal(browserControlNamesMatch('\uf011 Logout', 'Login'), false)
  assert.equal(browserControlNamesMatch('Delete account', 'Delete'), false)
  assert.equal(browserControlNamesMatch('\uf011', ''), false)
  assert.equal(browserControlNamesMatch('\uf011', '\uf012'), false)
  assert.equal(browserControlNamesMatch('Sign in ✕', 'Sign in'), false)
})
