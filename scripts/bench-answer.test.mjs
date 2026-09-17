import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanAnswer, isToolMarkupReply, looksLikeAnswer } from './bench-answer.mjs'

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

test('a fragment is not an answer', () => {
  // A closing reply that came back as a hesitation is the model failing to answer, and scoring
  // it as an answer reports a harness accident as a wrong prediction.
  assert.equal(looksLikeAnswer('. Hmm'), false)
  assert.equal(looksLikeAnswer('Hmm.'), false)
  assert.equal(looksLikeAnswer('um'), false)
  assert.equal(looksLikeAnswer(''), false)
  assert.equal(looksLikeAnswer('Amsterdam'), true)
  assert.equal(looksLikeAnswer('Hot Pot'), true)
  assert.equal(looksLikeAnswer('Unable to determine'), true)
})

test('a tool call written as text is never the answer, however it was mangled', () => {
  const mangled = '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="web_read">\n<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="url" string="true">https://example.test</\uFF5C\uFF5CDSML\uFF5C\uFF5C paramet'
  assert.equal(isToolMarkupReply(mangled), true)
  assert.equal(cleanAnswer(mangled), '')
  assert.equal(cleanAnswer('ANSWER: Lucha Underground'), 'Lucha Underground')
  assert.equal(isToolMarkupReply('The episode is Cero Miedo.'), false)
})
