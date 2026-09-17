// Summarize a benchmark report for stability: how often the same question produced the same
// answer, where each answer came from, and what the sources looked like at the start.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const report = JSON.parse(readFileSync(file, 'utf8'))
const byQuestion = new Map()
for (const result of report.results || []) {
  const key = result.answer
  if (!byQuestion.has(key)) byQuestion.set(key, [])
  byQuestion.get(key).push(result)
}
console.log(`report: ${file}`)
console.log(`model: ${report.model} | attempts: ${(report.results || []).length} | accuracy: ${report.accuracy}`)
console.log(`source health at start: ${(report.sourceHealth || []).join(' ')}`)
console.log(`answer tokens in evidence (mean): ${report.goldTokenRateMean}`)
for (const [answer, results] of byQuestion) {
  const verdicts = results.map(result => `${result.judge === 'correct' ? '✓' : '✗'}(${result.answerSource || 'model'})`)
  console.log(`  ${answer.slice(0, 46).padEnd(48)} ${verdicts.join(' ')} | seconds ${results.map(result => Math.round(result.seconds)).join('/')} | ledger ${results.map(result => result.ledgerUpdates ?? 0).join('/')}`)
}
const distinct = new Set((report.results || []).map(result => result.prediction))
console.log(`distinct predictions: ${distinct.size} of ${(report.results || []).length} attempts`)
