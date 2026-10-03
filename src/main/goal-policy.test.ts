import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { defaultGoalContinuations, maxGoalContinuations, parseTaskGoalCommand, type TaskGoal } from '../shared.ts'
import { GoalPolicy, runGoalCheck } from './goal-policy.ts'

const turn = (content: Array<Record<string, unknown>>) => ({ message: { role: 'assistant', content }, toolResults: [], context: { messages: [] }, newMessages: [] }) as unknown as PrepareNextTurnContext
const concluded = (text = 'Done: the work is complete.') => turn([{ type: 'text', text }])
const working = () => turn([{ type: 'toolCall', id: 'a', name: 'write', arguments: '{}' }])
const stopped = (reason: string) => ({ type: 'message_end', message: { role: 'assistant', stopReason: reason } }) as unknown as AgentSessionEvent

const goal = (objective: string, checks: TaskGoal['checks'], maxContinuations?: number): TaskGoal => ({ objective, checks, ...(maxContinuations === undefined ? {} : { maxContinuations }) })

async function workspace() {
  return mkdtemp(join(tmpdir(), 'shun-goal-'))
}

test('a declared check is decided by the filesystem, not by what the run said', async () => {
  const cwd = await workspace()
  try {
    const present: TaskGoal['checks'][number] = { id: 'check-1', description: 'file:result.txt', kind: 'file', path: 'result.txt' }
    const absent: TaskGoal['checks'][number] = { id: 'check-2', description: 'absent:scratch.txt', kind: 'absent', path: 'scratch.txt' }
    assert.equal((await runGoalCheck(cwd, present, { checkTimeoutMs: 5000, evidenceCharacters: 200 })).passed, false)
    assert.equal((await runGoalCheck(cwd, absent, { checkTimeoutMs: 5000, evidenceCharacters: 200 })).passed, true)
    await writeFile(join(cwd, 'result.txt'), 'ok')
    assert.equal((await runGoalCheck(cwd, present, { checkTimeoutMs: 5000, evidenceCharacters: 200 })).passed, true)
    // A check resolves against the task's workspace, never against the process's own directory.
    assert.equal((await runGoalCheck(cwd, { id: 'check-3', description: 'file:.', kind: 'file', path: '.' }, { checkTimeoutMs: 5000, evidenceCharacters: 200 })).passed, true)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a command check passes on exit 0 and fails with the output that said so', async () => {
  const cwd = await workspace()
  try {
    const limits = { checkTimeoutMs: 20_000, evidenceCharacters: 200 }
    const passing = await runGoalCheck(cwd, { id: 'check-1', description: 'run:echo fine', kind: 'command', command: 'echo fine' }, limits)
    assert.equal(passing.passed, true)
    assert.match(passing.observed, /exit 0: fine/)
    const failing = await runGoalCheck(cwd, { id: 'check-2', description: 'run:exit 3', kind: 'command', command: 'echo broken >&2; exit 3' }, limits)
    assert.equal(failing.passed, false)
    assert.match(failing.observed, /exit 3: broken/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a conclusion that leaves a declared condition unmet is sent back to work, and then accepted', async () => {
  const cwd = await workspace()
  try {
    const policy = new GoalPolicy({ goal: goal('Write the report', [{ id: 'check-1', description: 'file:report.md', kind: 'file', path: 'report.md' }], 2), cwd })
    // A turn that is still calling tools is work in progress, not a conclusion.
    assert.deepEqual(await policy.evaluate(working()), { status: 'accept' })
    const first = await policy.evaluate(concluded())
    assert.equal(first.status, 'continue')
    assert.match(String(first.feedback), /report\.md must exist — missing/)
    assert.match(String(first.feedback), /Write the report/)
    assert.match(String(first.feedback), /Continuation 1\/2/)
    // The second conclusion spends the budget, and the third is accepted because there is
    // nothing left to spend — the run stops with the gap on the record instead of being
    // walked in circles.
    assert.equal((await policy.evaluate(concluded())).status, 'continue')
    assert.equal((await policy.evaluate(concluded())).status, 'accept')
    const telemetry = policy.finish()
    assert.equal(telemetry.continuations, 2)
    assert.equal(telemetry.status, 'exhausted')
    assert.deepEqual(telemetry.failingChecks, ['check-1'])
    assert.equal(telemetry.budget, 2)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a conclusion is accepted as soon as the conditions hold, and nothing is spent', async () => {
  const cwd = await workspace()
  try {
    await writeFile(join(cwd, 'report.md'), 'done')
    const policy = new GoalPolicy({ goal: goal('Write the report', [{ id: 'check-1', description: 'file:report.md', kind: 'file', path: 'report.md' }]), cwd })
    assert.equal((await policy.evaluate(concluded())).status, 'accept')
    const telemetry = policy.finish()
    assert.equal(telemetry.continuations, 0)
    assert.equal(telemetry.status, 'met')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a goal with nothing checkable in it enforces nothing', async () => {
  const cwd = await workspace()
  try {
    const policy = new GoalPolicy({ goal: goal('Make it good', []), cwd })
    assert.equal((await policy.evaluate(concluded())).status, 'accept')
    const telemetry = policy.finish()
    assert.equal(telemetry.status, 'not-checked')
    assert.equal(telemetry.continuations, 0)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('the continuation budget a person declares is bounded by the product ceiling', async () => {
  const cwd = await workspace()
  try {
    const check: TaskGoal['checks'] = [{ id: 'check-1', description: 'file:never.txt', kind: 'file', path: 'never.txt' }]
    assert.equal(new GoalPolicy({ goal: goal('x', check, 10_000), cwd }).telemetry().budget, maxGoalContinuations)
    assert.equal(new GoalPolicy({ goal: goal('x', check, 0), cwd }).telemetry().budget, 1)
    assert.equal(new GoalPolicy({ goal: goal('x', check), cwd }).telemetry().budget, defaultGoalContinuations)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('guidance is written in the language the run is being held in, and the state is the last word', async () => {
  const cwd = await workspace()
  try {
    const policy = new GoalPolicy({ goal: goal('写出报告', [{ id: 'check-1', description: 'file:report.md', kind: 'file', path: 'report.md' }]), cwd, language: 'zh-CN' })
    const verdict = await policy.evaluate(concluded())
    assert.equal(verdict.status, 'continue')
    assert.match(String(verdict.feedback), /report\.md 必须存在 — 不存在/)
    assert.match(String(verdict.feedback), /写出报告/)
    assert.doesNotMatch(String(verdict.feedback), /must exist/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a run that ends with a failed check and no conclusion is recorded as unmet, not met', async () => {
  const cwd = await workspace()
  try {
    const policy = new GoalPolicy({ goal: goal('Write the report', [{ id: 'check-1', description: 'file:report.md', kind: 'file', path: 'report.md' }]), cwd })
    policy.observe(stopped('aborted'))
    const telemetry = policy.finish()
    assert.equal(telemetry.status, 'not-checked')
    assert.equal(telemetry.evaluations, 0)
    assert.equal(telemetry.finalStopReason, 'aborted')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('finishing twice reports the same record and closes the checks it was running', async () => {
  const cwd = await workspace()
  try {
    const policy = new GoalPolicy({ goal: goal('Write the report', [{ id: 'check-1', description: 'file:report.md', kind: 'file', path: 'report.md' }], 1), cwd })
    await policy.evaluate(concluded())
    const first = policy.finish()
    assert.deepEqual(policy.finish(), first)
    assert.equal(first.continuations, 1)
    assert.equal(first.status, 'unmet')
    assert.equal(first.declaredChecks, 1)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a command check says so while it runs, and a path check never needs to', async () => {
  const cwd = await workspace()
  try {
    const states: string[] = []
    const command = new GoalPolicy({
      goal: goal('Ship it', [{ id: 'check-1', description: 'run:true', kind: 'command', command: 'true' }]),
      cwd,
      onCheckStart: () => states.push('checking'),
      onCheckEnd: () => states.push('thinking'),
    })
    await command.evaluate(concluded())
    assert.deepEqual(states, ['checking', 'thinking'])
    const pathOnlyStates: string[] = []
    const pathOnly = new GoalPolicy({
      goal: goal('Ship it', [{ id: 'check-1', description: 'file:report.md', kind: 'file', path: 'report.md' }]),
      cwd,
      onCheckStart: () => pathOnlyStates.push('checking'),
      onCheckEnd: () => pathOnlyStates.push('thinking'),
    })
    await pathOnly.evaluate(concluded())
    assert.deepEqual(pathOnlyStates, [])
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('a goal is written the way a person writes it, and a goal nothing can decide is refused', () => {
  assert.deepEqual(parseTaskGoalCommand('/goal'), { kind: 'show' })
  assert.deepEqual(parseTaskGoalCommand('/goal --clear'), { kind: 'clear' })
  const set = parseTaskGoalCommand('/goal Ship the importer --check file:dist/report.md --check run:pnpm test --check absent:scratch/')
  assert.equal(set.kind, 'set')
  assert.equal(set.kind === 'set' ? set.goal.objective : '', 'Ship the importer')
  assert.deepEqual(set.kind === 'set' ? set.goal.checks.map(check => [check.kind, check.description]) : [], [
    ['file', 'file:dist/report.md'],
    ['command', 'run:pnpm test'],
    ['absent', 'absent:scratch/'],
  ])
  // Completion has to be decidable by something other than the run's own account of itself.
  assert.deepEqual(parseTaskGoalCommand('/goal Make it good'), { kind: 'error', reason: 'no-check' })
  assert.deepEqual(parseTaskGoalCommand('/goal --check file:x.md'), { kind: 'error', reason: 'empty-objective' })
  assert.deepEqual(parseTaskGoalCommand('/goal Do it --check sometimes:x'), { kind: 'error', reason: 'unsupported-check', value: 'sometimes:x' })
  assert.deepEqual(parseTaskGoalCommand('/goal Do it --check --check file:x.md'), { kind: 'error', reason: 'empty-check' })
})
