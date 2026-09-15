/**
 * BrowseComp research benchmark for Shun's retrieval stack.
 *
 * BrowseComp (OpenAI) is 1,266 short-answer questions whose answers are trivial
 * to verify once found and hard to locate without persistent browsing, which is
 * exactly the capability under test. This harness drives the *product* retrieval
 * path (searchWeb + readWeb, the keyless stack) with the configured model and
 * reports both end-to-end accuracy and, separately, whether the gold answer ever
 * appeared in the retrieved evidence. The two numbers separate retrieval weakness
 * from model weakness.
 *
 *   node --experimental-strip-types scripts/research-bench.mjs [--count 30] [--seed 0]
 *     [--turns 8] [--searches 5] [--reads 8] [--question-seconds 120] [--concurrency 6]
 *
 * The agent loop gets the same mechanism the product gives it and nothing more:
 * the tools, and the research policy rule that discovery holding leads which were
 * never opened may not issue another search. There is deliberately no coaching
 * beyond that, because a benchmark that is steered into good behavior measures
 * the steering rather than the system.
 *
 * The official set is XOR-encrypted with a per-row canary so it cannot be
 * scraped; it is decrypted here exactly as openai/simple-evals does. Grading is an
 * LLM judge over a short answer, as in the official harness, with a literal match
 * recorded alongside it. A subset run is not a leaderboard submission.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readWeb, searchWeb } from '../src/main/web.ts'

const DATASET_URL = 'https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv'
const DEFAULT_COUNT = 30, DEFAULT_TURNS = 8, DEFAULT_SEARCHES = 5, DEFAULT_READS = 8
const DEFAULT_QUESTION_SECONDS = 120, DEFAULT_CONCURRENCY = 6

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

/** Model and endpoint come from the running app's own settings, never from a literal. */
async function loadProvider() {
  const endpoint = process.env.SHUN_BENCH_ENDPOINT || ''
  const apiKey = process.env.SHUN_BENCH_API_KEY || ''
  const model = process.env.SHUN_BENCH_MODEL || ''
  if (endpoint && apiKey && model) return { endpoint, apiKey, model }
  for (const candidate of [join(homedir(), 'Library/Application Support/shun/state.json'), join(homedir(), 'Library/Application Support/Shun/state.json')]) {
    try {
      const settings = JSON.parse(await readFile(candidate, 'utf8'))?.settings
      if (settings?.endpoint && settings?.apiKey && settings?.model) return { endpoint: endpoint || settings.endpoint, apiKey: apiKey || settings.apiKey, model: model || settings.model }
    } catch {}
  }
  throw Error('no provider configured: set SHUN_BENCH_ENDPOINT, SHUN_BENCH_API_KEY, and SHUN_BENCH_MODEL')
}

function deriveKey(password, length) {
  const digest = createHash('sha256').update(password).digest()
  return Buffer.concat(Array(Math.ceil(length / digest.length)).fill(digest)).subarray(0, length)
}

export function decryptField(ciphertext, canary) {
  const encrypted = Buffer.from(ciphertext, 'base64'), key = deriveKey(canary, encrypted.length)
  for (let index = 0; index < encrypted.length; index++) encrypted[index] ^= key[index]
  return encrypted.toString('utf8')
}

/** RFC-4180 parsing: BrowseComp questions contain quoted commas and newlines. */
export function parseCsv(text) {
  const rows = []
  let row = [], field = '', quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index++ }
      else if (character === '"') quoted = false
      else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') { row.push(field); field = '' }
    else if (character === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (character !== '\r') field += character
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows
}

export async function loadQuestions(count, seed) {
  const cache = join(process.cwd(), 'tmp/browsecomp-test-set.csv')
  let csv = ''
  try { csv = await readFile(cache, 'utf8') } catch {}
  if (!csv) {
    const response = await fetch(DATASET_URL)
    if (!response.ok) throw Error(`BrowseComp dataset download failed: HTTP ${response.status}`)
    csv = await response.text()
    await mkdir(dirname(cache), { recursive: true })
    await writeFile(cache, csv)
  }
  const [header, ...rows] = parseCsv(csv), columns = Object.fromEntries(header.map((name, index) => [name, index]))
  const questions = rows.filter(row => row.length > 1).map(row => ({
    problem: decryptField(row[columns.problem], row[columns.canary]),
    answer: decryptField(row[columns.answer], row[columns.canary]),
    topic: row[columns.problem_topic],
  }))
  // mulberry32 keeps the subset reproducible without pulling in a dependency.
  let state = (seed >>> 0) + 0x6d2b79f5
  const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const pool = questions.slice()
  for (let index = pool.length - 1; index > 0; index--) { const swap = Math.floor(random() * (index + 1));[pool[index], pool[swap]] = [pool[swap], pool[index]] }
  return { total: questions.length, sample: pool.slice(0, count) }
}

export function normalizeAnswer(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\b(?:a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim()
}

export function answerMatches(prediction, gold) {
  const predicted = normalizeAnswer(prediction), expected = normalizeAnswer(gold)
  if (!predicted || !expected) return false
  return predicted === expected || predicted.includes(expected)
}

export function goldInEvidence(evidence, gold) {
  const expected = normalizeAnswer(gold)
  return Boolean(expected) && evidence.some(text => normalizeAnswer(text).includes(expected))
}

/**
 * DeepSeek-family models can return the whole turn in `reasoning_content` with an
 * empty `content`, and reading only `content` silently discards real answers.
 */
function messageText(message) {
  return String(message.content || '').trim() || String(message.reasoning_content || '').trim()
}

/** Thinking models reject a forced tool_choice and spend output budget on reasoning first. */
async function chat(provider, messages, tools, maxTokens = 8_000) {
  const response = await fetch(`${provider.endpoint.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ model: provider.model, messages, ...(tools?.length ? { tools } : {}), temperature: 0.2, max_tokens: maxTokens }),
  })
  if (!response.ok) throw Error(`model call failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
  const payload = await response.json(), choice = payload.choices?.[0], message = choice?.message
  if (!message) throw Error(`model returned no message: ${JSON.stringify(payload).slice(0, 300)}`)
  message.finish_reason = choice?.finish_reason
  return message
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web for candidate URLs. Returns ranked results with snippets and a confidence for each: direct means the result sits on the query subject\u2019s own domain, lead means it only mentions the clues.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, site: { type: 'string' }, exact_phrases: { type: 'array', items: { type: 'string' } } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_read',
      description: 'Open one public URL and return its readable text. Use the field query to rank outbound links toward what you are looking for.',
      parameters: { type: 'object', properties: { url: { type: 'string' }, query: { type: 'string' }, offset: { type: 'integer' } }, required: ['url'] },
    },
  },
]

const SYSTEM = 'Answer the question below by researching the public web with the provided tools. When your evidence names one short answer, reply with a final message whose last line is "ANSWER: <answer>".'

/**
 * A final message can carry malformed tool markup around the answer, so the answer
 * is extracted with any XML-ish residue and quoting removed. A model sometimes
 * writes a tool call as text instead of calling the tool, and that remnant is not
 * an answer: scoring it would measure the harness rather than the run.
 */
export function cleanAnswer(text) {
  const cleaned = String(text || '')
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/gi, ' ')
    .replace(/<invoke[\s\S]*?<\/invoke>/gi, ' ')
    .replace(/<parameter[\s\S]*?<\/parameter>/gi, ' ')
    .replace(/<\/?[a-zA-Z_][^>]*>/g, ' ')
  const strip = value => value.replace(/^["'\s]+|["'.\s]+$/g, '').trim()
  const marked = cleaned.match(/ANSWER:\s*([^\n]+)/i)?.[1]
  if (marked && /[\p{L}\p{N}]/u.test(marked)) return strip(marked)
  const lines = cleaned.split('\n').map(line => strip(line)).filter(line => /[\p{L}\p{N}]{2,}/u.test(line))
  return lines[lines.length - 1] || ''
}

/**
 * A thinking model spends its output budget on deliberation, so a closing request
 * with a small budget comes back as unfinished reasoning with no answer in it. The
 * closing turn therefore forbids deliberation, and a reply that was cut off or that
 * only wrote tool markup is retried instead of being scored as an answer.
 */
async function finalAnswer(provider, messages) {
  const instruction = 'Stop deliberating now. Reply with one short sentence of justification, then a final line exactly "ANSWER: <short answer>". Do not weigh alternatives in the reply, and do not write tool calls as text.'
  for (const maxTokens of [2_000, 6_000]) {
    const reply = await chat(provider, [...messages, { role: 'user', content: instruction }], undefined, maxTokens)
    const text = messageText(reply)
    if (cleanAnswer(text)) return { text, truncated: reply.finish_reason === 'length' }
  }
  return { text: '', truncated: true }
}

async function runQuestion(provider, question, limits) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: question.problem }]
  const evidence = [], trace = []
  const deadline = Date.now() + limits.questionMs
  let searches = 0, reads = 0, turns = 0, leads = 0, answer = '', failure = ''

  while (turns < limits.turns && Date.now() < deadline) {
    turns++
    let message
    try { message = await chat(provider, messages, TOOLS) }
    catch (error) { failure = String(error.message || error); break }
    const text = messageText(message), calls = message.tool_calls || []
    messages.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) })
    if (!calls.length) { answer = text; break }

    for (const call of calls) {
      let output = '', logged
      try {
        const args = JSON.parse(call.function?.arguments || '{}')
        if (call.function?.name === 'web_search') {
          // The product's research policy refuses further discovery while leads it
          // already found are unopened; the harness applies the same rule so the
          // measurement reflects the shipped mechanism.
          if (reads === 0 && searches >= 2 && leads > 0) output = JSON.stringify({ error: 'search blocked: discovery already returned leads and none has been opened. Use web_read on the strongest lead, then search again if needed.' })
          else if (searches >= limits.searches) output = JSON.stringify({ error: 'search budget exhausted for this question; answer from what you have' })
          else {
            searches++
            const started = Date.now()
            output = await searchWeb(args.query, 8, { site: args.site, exactPhrases: args.exact_phrases })
            const parsed = JSON.parse(output)
            leads += (parsed.results || []).length
            logged = { tool: 'web_search', query: args.query, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), widened: parsed.retrieval?.widened_with, results: (parsed.results || []).map(row => `${row.match?.confidence}:${row.url}`).slice(0, 8), channels: (parsed.retrieval?.providers || []).map(item => `${item.id}:${item.status}`) }
          }
        } else if (call.function?.name === 'web_read') {
          if (reads >= limits.reads) output = JSON.stringify({ error: 'read budget exhausted for this question; answer from what you have' })
          else {
            reads++
            const started = Date.now()
            output = await readWeb(args.url, 8_000, undefined, args.offset, undefined, args.query)
            logged = { tool: 'web_read', url: args.url, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), bytes: output.length, title: (() => { try { return JSON.parse(output).title } catch { return undefined } })() }
          }
        } else output = JSON.stringify({ error: `unknown tool ${call.function?.name}` })
      } catch (error) { output = JSON.stringify({ error: String(error.message || error).slice(0, 400) }) }
      if (logged) trace.push(logged)
      evidence.push(output)
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }

  // A run that spends its whole budget still has to produce an answer, otherwise
  // the harness measures the loop crashing rather than the pipeline's capability.
  let closingText = ''
  if (!answer || !/ANSWER:/i.test(answer)) {
    try {
      const closing = await finalAnswer(provider, messages)
      closingText = closing.text
      if (closingText) answer = closingText
      else failure = failure || 'no marked answer was produced' + (closing.truncated ? ' (reply truncated twice)' : '')
    } catch (error) { failure = failure || String(error.message || error) }
  }

  const final = cleanAnswer(answer)

  let judge = answerMatches(final, question.answer) ? 'correct' : 'incorrect'
  let judgeNote = 'literal match'
  if (judge === 'incorrect' && final) {
    try {
      const verdict = await chat(provider, [
        { role: 'system', content: 'You grade a short factual answer. Reply with exactly "correct" or "incorrect". A prediction is correct when it names the same entity, value, or span as the reference, allowing formatting differences; extra words that do not change the meaning are acceptable.' },
        { role: 'user', content: `Question: ${question.problem}\nReference answer: ${question.answer}\nPredicted answer: ${final}` },
      ], undefined, 2_000)
      judgeNote = 'llm judge'
      if (/correct/i.test(verdict.content || '') && !/incorrect/i.test(verdict.content || '')) judge = 'correct'
    } catch (error) { judgeNote = `judge failed: ${String(error.message || error).slice(0, 120)}` }
  }
  return { ...question, prediction: final, closingText: closingText.slice(0, 500), judge, judgeNote, turns, searches, reads, leads, seconds: Number(((Date.now() - (deadline - limits.questionMs)) / 1000).toFixed(1)), trace, goldInEvidence: goldInEvidence(evidence, question.answer), failure }
}

/** Questions are independent, so the subset runs concurrently instead of serially. */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}

export function percentile(values, fraction) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b), position = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[position]
}

const provider = await loadProvider()
const count = Number(argument('count', DEFAULT_COUNT)), seed = Number(argument('seed', 0))
const limits = {
  turns: Number(argument('turns', DEFAULT_TURNS)),
  searches: Number(argument('searches', DEFAULT_SEARCHES)),
  reads: Number(argument('reads', DEFAULT_READS)),
  questionMs: Number(argument('question-seconds', DEFAULT_QUESTION_SECONDS)) * 1_000,
}
const concurrency = Math.max(1, Number(argument('concurrency', DEFAULT_CONCURRENCY)))
const { total, sample } = await loadQuestions(count, seed)
const out = argument('out', join('tmp', `browsecomp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))

console.log(`BrowseComp subset: ${sample.length} of ${total} questions (seed ${seed}) on ${provider.model}, ${concurrency} at a time, ${limits.questionMs / 1000}s per question`)
const started = Date.now()
let finished = 0, correctSoFar = 0
const results = await runWithConcurrency(sample, concurrency, async (question, index) => {
  const result = await runQuestion(provider, question, limits)
  finished++
  if (result.judge === 'correct') correctSoFar++
  console.log(`[${finished}/${sample.length}] ${result.judge === 'correct' ? 'CORRECT' : 'wrong  '} | gold-in-evidence=${result.goldInEvidence ? 'yes' : 'no '} | ${result.searches}s/${result.reads}r ${result.seconds}s | running ${correctSoFar}/${finished}`)
  console.log(`        gold=${question.answer} | predicted=${result.prediction.slice(0, 80) || '(none)'}${result.failure ? ` | failure=${result.failure.slice(0, 100)}` : ''}`)
  return result
})

const correct = results.filter(item => item.judge === 'correct').length
const latencies = results.map(item => item.seconds)
const searchLatencies = results.flatMap(item => item.trace.filter(step => step.tool === 'web_search').map(step => step.seconds))
const summary = {
  model: provider.model,
  questions: results.length,
  seed,
  limits,
  concurrency,
  accuracy: Number((correct / results.length).toFixed(4)),
  goldInEvidenceRate: Number((results.filter(item => item.goldInEvidence).length / results.length).toFixed(4)),
  totalSeconds: Math.round((Date.now() - started) / 1000),
  questionSeconds: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
  searchSeconds: { count: searchLatencies.length, p50: percentile(searchLatencies, 0.5), p95: percentile(searchLatencies, 0.95) },
  results,
}
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(summary, null, 2))
console.log(`\nBrowseComp subset accuracy: ${correct}/${results.length} = ${(summary.accuracy * 100).toFixed(1)}%`)
console.log(`gold answer ever present in retrieved evidence: ${(summary.goldInEvidenceRate * 100).toFixed(1)}%`)
console.log(`question seconds p50=${summary.questionSeconds.p50} p95=${summary.questionSeconds.p95} | search p50=${summary.searchSeconds.p50} p95=${summary.searchSeconds.p95} | total ${summary.totalSeconds}s`)
console.log(`report: ${out}`)
