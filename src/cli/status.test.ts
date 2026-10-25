import test from 'node:test'
import assert from 'node:assert/strict'
import { visibleWidth } from '@earendil-works/pi-tui'
import { statusLine, gitStatus } from './status.ts'
import { activityPhase } from './markdown.ts'
test('status shows project, branch, model and real context with bounded width', () => {
 const context = { state: 'ready' as const, usedTokens: 15000, budgetTokens: 128000, usedCharacters: 0, budgetCharacters: 0, exactTokens: true }
 assert.equal(statusLine('model', '/code/shun', 'main*', context, 100), 'shun · main* · model · 15k / 128k · 12%')
 assert.ok(visibleWidth(statusLine('long-model-name', '/code/shun', 'long-branch', context, 25)) <= 25)
 assert.equal(statusLine('model', '', '', undefined, 100), 'model')
})
test('compacting animates independently of model output', () => {
 assert.match(activityPhase('Compacting', true, 0), /Compacting/)
 assert.notEqual(activityPhase('Compacting', true, 0), activityPhase('Compacting', true, 1))
 assert.equal(activityPhase('Compacted', false, 2), 'Compacted')
})
test('no project does not probe the current repository', async () => assert.equal(await gitStatus(''), ''))
