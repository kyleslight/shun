import assert from 'node:assert/strict'
import test from 'node:test'
import { boundDigest, defaultResearchFanoutLimits, formatResearchFindings, planResearchQuestions, runResearchFanout } from './research-fanout.ts'

test('planning keeps the questions worth an explorer and reports what it dropped', () => {
  assert.deepEqual(planResearchQuestions([' a  b ', 'A B', '', '  ', 'c'], 4), { questions: ['a b', 'c'], skipped: 0 })
  assert.deepEqual(planResearchQuestions(['one', 'two', 'three'], 2), { questions: ['one', 'two'], skipped: 1 })
  assert.deepEqual(planResearchQuestions(undefined, 3), { questions: [], skipped: 0 })
})

test('a digest is bounded at the explorer boundary', () => {
  const long = 'x'.repeat(500)
  const bounded = boundDigest(long, 100)
  assert.equal(bounded.length, 100)
  assert.match(bounded, /truncated at the explorer boundary/)
  assert.equal(boundDigest('  short  ', 100), 'short')
})

test('explorers run in parallel but never above the limit, and each keeps its own question', async () => {
  let inFlight = 0, peak = 0
  const result = await runResearchFanout(['one', 'two', 'three', 'four'], async question => {
    peak = Math.max(peak, ++inFlight)
    await new Promise(resolve => setTimeout(resolve, 20))
    inFlight--
    return `findings for ${question}`
  }, { ...defaultResearchFanoutLimits, maxParallel: 2 })

  assert.equal(peak, 2)
  assert.deepEqual(result.findings.map(finding => finding.question), ['one', 'two', 'three', 'four'])
  assert.deepEqual(result.findings.map(finding => finding.status), ['ok', 'ok', 'ok', 'ok'])
  assert.match(result.findings[2].digest, /findings for three/)
})

test('one explorer failing never discards the work of the others', async () => {
  const result = await runResearchFanout(['good', 'bad', 'also good'], async question => {
    if (question === 'bad') throw Error('explorer exploded')
    return `answer for ${question}`
  }, { ...defaultResearchFanoutLimits, maxParallel: 2 })

  assert.deepEqual(result.findings.map(finding => finding.status), ['ok', 'failed', 'ok'])
  assert.equal(result.findings[1].digest, '')
  assert.match(result.findings[0].digest, /answer for good/)
})

test('an explorer that runs too long is abandoned instead of holding the fan-out', async () => {
  const result = await runResearchFanout(['slow'], () => new Promise(() => {}), { ...defaultResearchFanoutLimits, timeoutMs: 40 })
  assert.equal(result.findings[0].status, 'timeout')
})

test('more questions than explorers are reported as skipped rather than silently dropped', async () => {
  const result = await runResearchFanout(['one', 'two', 'three'], async question => question, { ...defaultResearchFanoutLimits, maxExplorers: 2 })
  assert.equal(result.started, 2)
  assert.equal(result.skipped, 1)
  assert.match(result.reason || '', /2 explorers/)
})

test('cancelling the fan-out stops the explorers it started', async () => {
  const controller = new AbortController()
  const seen: string[] = []
  const running = runResearchFanout(['a', 'b', 'c', 'd'], async (question, signal) => {
    seen.push(question)
    if (question === 'a') controller.abort()
    await new Promise(resolve => setTimeout(resolve, 10))
    if (signal.aborted) throw Error('aborted')
    return question
  }, { ...defaultResearchFanoutLimits, maxParallel: 1 }, controller.signal)
  const result = await running
  assert.deepEqual(seen, ['a'], 'no further explorer starts after cancellation')
  assert.equal(result.findings.some(finding => finding.status === 'ok'), false)
})

test('the digest handed to the lead agent carries findings and failures, not transcripts', async () => {
  const result = await runResearchFanout(['fine', 'broken'], async question => {
    if (question === 'broken') throw Error('nope')
    return 'The 1973 film was directed by someone else.'
  }, { ...defaultResearchFanoutLimits, maxParallel: 2 })
  const text = formatResearchFindings(result)
  assert.match(text, /### fine/)
  assert.match(text, /The 1973 film was directed by someone else\./)
  assert.match(text, /### broken/)
  assert.match(text, /explorer failed/)
  assert.equal(formatResearchFindings(await runResearchFanout([], async () => '')).includes('No explorer returned findings'), true)
})
