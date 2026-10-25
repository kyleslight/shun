import test from 'node:test'
import assert from 'node:assert/strict'
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { answerMarkdown, activityPhase } from './markdown.ts'

test('answers render Markdown structure, inline styles and width-aware tables', () => {
  const source = '# Heading\n\n**Bold** and [link](https://example.com)\n\n- Item\n\n```js\nconst n = 1\n```\n\n| Name | Count |\n| --- | --- |\n| Campaign | 3 |'
  const lines = answerMarkdown(source).render(45), text = lines.map(stripTerminalSequences).join('\n')
  assert.match(text, /Heading/); assert.doesNotMatch(text, /# Heading|\*\*Bold\*\*|```/)
  assert.match(text, /const n = 1/); assert.match(text, /Campaign/)
  assert.ok(lines.every(line => visibleWidth(line) <= 45))
})

test('thinking advances without leading empty lines and stops animating when complete', () => {
  assert.notEqual(activityPhase('Thinking', true, 0), activityPhase('Thinking', true, 1))
  assert.ok(!activityPhase('', true, 0).startsWith('\n'))
  assert.equal(activityPhase('Stopped', false, 5), 'Stopped')
  assert.equal(activityPhase('', false, 5), '')
})
