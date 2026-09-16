import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanAnswer } from './bench-answer.mjs'

test('the answer is read from the marked last line', () => {
  assert.equal(cleanAnswer('The evidence points to one person.\nANSWER: Raffaele Contigiani'), 'Raffaele Contigiani')
  assert.equal(cleanAnswer('ANSWER: "Amsterdam".'), 'Amsterdam')
  assert.equal(cleanAnswer('no marker here\nso the last line is the answer'), 'so the last line is the answer')
  assert.equal(cleanAnswer(''), '')
})

test('tool markup written as text is never scored as an answer', () => {
  // A provider that delimits its tool markup with full-width bars, and leaves the
  // closing bracket off, produced exactly this and it was scored as an answer.
  assert.equal(cleanAnswer('</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>'), '')
  assert.equal(cleanAnswer('<tool_calls><invoke name="web_search"><parameter name="query">x</parameter></invoke></tool_calls>'), '')
  // The answer that follows the remnant is still read.
  assert.equal(cleanAnswer('</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\nThe evidence names it.\nANSWER: Hot Pot'), 'Hot Pot')
  assert.equal(cleanAnswer('<tool_calls><invoke/></tool_calls>\nANSWER: Afrigo Band'), 'Afrigo Band')
})
