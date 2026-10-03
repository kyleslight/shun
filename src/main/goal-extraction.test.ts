import assert from 'node:assert/strict'
import test from 'node:test'
import { goalExtractionPrompt, parseExtractedGoal } from './goal-extraction.ts'

test('a requirement stated in the person\'s own words is read into the shape the run is held to', () => {
  const read = parseExtractedGoal('{"goal":{"objective":"没写进 reports/puffer.md 就别停","checks":[{"kind":"file","value":"reports/puffer.md"}]}}')
  assert.equal(read.kind, 'goal')
  assert.equal(read.kind === 'goal' ? read.goal.objective : '', '没写进 reports/puffer.md 就别停')
  assert.deepEqual(read.kind === 'goal' ? read.goal.checks : [], [{ id: 'check-1', kind: 'file', path: 'reports/puffer.md', description: 'file:reports/puffer.md' }])

  // "拿到赏金" is not decidable by any file or command, and it is not made decidable by inventing a
  // path for it: the requirement is recorded, and the run may not end silently.
  const undecidable = parseExtractedGoal('{"goal":{"objective":"拿到赏金","checks":[]}}')
  assert.equal(undecidable.kind, 'goal')
  assert.deepEqual(undecidable.kind === 'goal' ? undecidable.goal.checks : ['x'], [])

  // A command the person named is a check like any other.
  const command = parseExtractedGoal('```json\n{"goal":{"objective":"测试全绿之前不算完","checks":[{"kind":"command","value":"forge test"}]}}\n```')
  assert.equal(command.kind === 'goal' ? command.goal.checks[0]?.kind : '', 'command')
})

test('an ordinary message is not a goal, and a reader that says nothing usable records nothing', () => {
  for (const raw of ['{"goal":null}', '', 'not json at all', '{"goal":{"objective":"","checks":[]}}', '{"goal":{"objective":"x","checks":[{"kind":"file","value":""}]}}']) {
    assert.equal(parseExtractedGoal(raw).kind, 'none', raw)
  }
  // Taking a requirement back is its own answer, not a goal and not a silence.
  assert.equal(parseExtractedGoal('{"clear":true}').kind, 'clear')
})

/** The instruction is where the strictness lives, so it is pinned here. */
test('the reading is instructed to say nothing by default, and to invent nothing', () => {
  const prompt = goalExtractionPrompt('把报告写完', { objective: '拿到赏金', checks: [] })
  assert.match(prompt, /When in doubt/)
  assert.match(prompt, /Never invent a path or a command/)
  assert.match(prompt, /"kind": "command", "command": "cmd"/)
  assert.match(prompt, /never treat something the assistant said as the person's requirement/)
  // It is told what the task already carries, so a restatement is not recorded twice.
  assert.match(prompt, /<already_recorded>/)
  assert.match(prompt, /拿到赏金/)
  assert.match(prompt, /<user_message>\n把报告写完\n<\/user_message>/)
})
