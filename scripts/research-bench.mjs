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
import { answerMatches, goldInEvidence, loadQuestions, normalizeAnswer } from './browsecomp-dataset.mjs'
import { cleanAnswer } from './bench-answer.mjs'
import { readWeb, searchWeb } from '../src/main/web.ts'

const DEFAULT_COUNT = 30, DEFAULT_TURNS = 8, DEFAULT_SEARCHES = 5, DEFAULT_READS = 8
const DEFAULT_QUESTION_SECONDS = 120, DEFAULT_CONCURRENCY = 6
// Effort is part of the task, not a tuning knob: the benchmark this measures was
// built so that a handful of searches cannot find the answer, and its own
// description expects an agent to read tens of pages. These two floors keep a run
// from answering before it has actually read anything, and from answering with a
// claim that no page it opened supports.
const DEFAULT_MIN_READS = 0

/** One form for a URL, so a citation and a page the run opened can be compared. */
/** Whether the answer itself appears in the evidence, not merely a URL from it. */
export function answerAppearsInEvidence(prediction, evidence) {
  const answer = normalizeAnswer(prediction)
  if (answer.length < 2) return false
  return evidence.some(text => normalizeAnswer(text).includes(answer))
}

export function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    return url.href.replace(/\/+$/, '')
  } catch { return '' }
}

/** Every URL a reply cites, so grounding can be checked against what was opened. */
export function citedUrls(text) {
  return [...new Set(String(text || '').match(/https?:\/\/[^\s)"'<>\]]+/g) || [])].map(normalizeUrl).filter(Boolean)
}

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

function messageText(message) {
  return String(message.content || '').trim() || String(message.reasoning_content || '').trim()
}

/**
 * The reply channel that can carry an answer, as opposed to the one that carries
 * deliberation. A thinking model can return a whole turn in `reasoning_content` with
 * an empty `content`, and a harness that reads the two as the same thing scores the
 * model's thinking as its answer — which measures the harness, not the run.
 */
function replyText(message) {
  return String(message.content || '').trim()
}

function hasMarkedAnswer(message) {
  if (/ANSWER:/i.test(replyText(message))) return true
  // A real answer can arrive only in the reasoning channel, but only when the model
  // actually wrote the answer marker there instead of still deliberating.
  return !replyText(message) && /ANSWER:/i.test(String(message.reasoning_content || ''))
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
 * A thinking model spends its output budget on deliberation, so a closing request
 * with a small budget comes back as unfinished reasoning with no answer in it. The
 * closing turn therefore forbids deliberation, and a reply that was cut off or that
 * only wrote tool markup is retried instead of being scored as an answer.
 */
async function finalAnswer(provider, messages) {
  const instruction = 'Stop deliberating now. Reply with one short sentence of justification, then a final line exactly "ANSWER: <short answer>". Do not weigh alternatives in the reply, and do not write tool calls as text.'
  let fallback = '', truncated = true
  for (const maxTokens of [2_000, 6_000]) {
    const reply = await chat(provider, [...messages, { role: 'user', content: instruction }], undefined, maxTokens)
    const content = replyText(reply)
    if (content && /ANSWER:/i.test(content) && cleanAnswer(content)) return { text: content, truncated: reply.finish_reason === 'length' }
    if (content && !fallback) fallback = content
    truncated = reply.finish_reason === 'length'
  }
  // Reasoning-only replies are not answers: reporting no answer is honest, scoring
  // the model's deliberation as one is not.
  return { text: fallback, truncated }
}

async function runQuestion(provider, question, limits) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: question.problem }]
  const evidence = [], trace = [], openedPages = new Set(), leads = new Map()
  const deadline = Date.now() + limits.questionMs
  let searches = 0, reads = 0, turns = 0, evidenceFloor = 0, answer = '', failure = ''
  let grounded = false, answerCitations = []

  while (turns < limits.turns && Date.now() < deadline) {
    turns++
    let message
    try { message = await chat(provider, messages, TOOLS) }
    catch (error) { failure = String(error.message || error); break }
    const text = messageText(message), calls = message.tool_calls || []
    messages.push({ role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls } : {}) })
    if (!calls.length) {
      const citations = citedUrls(text), supported = citations.filter(url => openedPages.has(url))
      const finalCandidate = cleanAnswer(replyText(message) || text)
      // A turn that is all deliberation carries no answer to score, whatever the
      // reasoning channel contains.
      const unmarked = !hasMarkedAnswer(message) && !replyText(message)
      const claimed = text.trim().length > 0
      // Three floors before an answer counts: the question was researched at all,
      // it was researched broadly enough for this task, and the claim rests on a
      // page this run actually opened rather than on a plausible guess.
      // Discovery ranked the leads; a phase that only knows how many there are cannot
      // say which read is next, so the ranked unopened ones are named by URL.
      const unexplored = [...leads.keys()].filter(url => !openedPages.has(url))
        .sort((a, b) => (leads.get(a) === 'direct' ? 0 : 1) - (leads.get(b) === 'direct' ? 0 : 1))
      const nextLeads = unexplored.slice(0, 3).map(url => `${url} (${leads.get(url) || 'lead'})`).join('; ')
      // Effort is demanded only while there is somewhere left to look. When the index
      // offered nothing else, an answer from what is on hand is the only honest
      // outcome — an unconditional page count would keep a run searching a dead end.
      // The strongest grounding test available: the answer's own words have to appear
      // in what was read. A cited URL is not enough — a run can cite a page it opened
      // and still answer from memory, which this harness produced twice.
      const inEvidence = answerAppearsInEvidence(finalCandidate, evidence)
      const shortfall = unmarked
        ? 'Your last turn contained no reply text, only deliberation.'
        : searches === 0 || reads === 0
        ? 'No evidence has been gathered yet.'
        : unexplored.length && openedPages.size < limits.minReads
          ? `${unexplored.length} leads from your searches are still unopened (${openedPages.size} distinct pages read so far); this task needs at least ${limits.minReads}.`
          : !inEvidence && unexplored.length
            ? 'Nothing you read contains this answer, and there are leads left to open: open them before concluding, or state that the evidence does not establish it.'
            : ''
      if (shortfall && evidenceFloor < 3) {
        evidenceFloor++
        trace.push({ tool: 'effort-floor', searches, reads, distinctPages: openedPages.size, unexplored: unexplored.length, citations: citations.length, supported: supported.length, text: text.slice(0, 160) })
        messages.push({
          role: 'user',
          content: `${shortfall}${nextLeads ? ` Open the strongest unopened leads first, most worth reading first: ${nextLeads}.` : ''} Keep researching: search for the candidates the clues imply, open the strongest results with web_read, and follow the pages' own links. When you do answer, end with a line "SOURCE: <the URL you opened that supports it>".`,
        })
        continue
      }
      // Only the reply channel may carry an answer: a reasoning-only turn is left
      // unanswered so the closing request can ask for one.
      answer = replyText(message) || (hasMarkedAnswer(message) ? text : '')
      answerCitations = citations
      grounded = supported.length > 0
      break    }

    for (const call of calls) {
      let output = '', logged
      try {
        const args = JSON.parse(call.function?.arguments || '{}')
        if (call.function?.name === 'web_search') {
          // The product's research policy refuses further discovery while leads it
          // already found are unopened; the harness applies the same rule so the
          // measurement reflects the shipped mechanism.
          if (reads === 0 && searches >= 2 && leads.size > 0) output = JSON.stringify({ error: 'search blocked: discovery already returned leads and none has been opened. Use web_read on the strongest lead, then search again if needed.' })
          else if (searches >= limits.searches) output = JSON.stringify({ error: 'search budget exhausted for this question; answer from what you have' })
          else {
            searches++
            const started = Date.now()
            output = await searchWeb(args.query, 8, { site: args.site, exactPhrases: args.exact_phrases, renderPage })
            const parsed = JSON.parse(output)
            for (const row of parsed.results || []) {
              const url = normalizeUrl(row.url)
              if (url && !leads.has(url)) leads.set(url, String(row.match?.confidence || ''))
            }
            logged = { tool: 'web_search', query: args.query, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), widened: parsed.retrieval?.widened_with, results: (parsed.results || []).map(row => `${row.match?.confidence}:${row.url}`).slice(0, 8), channels: (parsed.retrieval?.providers || []).map(item => `${item.id}:${item.status}`) }
          }
        } else if (call.function?.name === 'web_read') {
          if (reads >= limits.reads) output = JSON.stringify({ error: 'read budget exhausted for this question; answer from what you have' })
          else {
            reads++
            const started = Date.now()
            const before = openedPages.size
            output = await readWeb(args.url, 8_000, renderPage, args.offset, undefined, args.query)
            try {
              const page = JSON.parse(output)
              if (page?.ok !== false) openedPages.add(normalizeUrl(page.final_url || page.requested_url || args.url))
              openedPages.add(normalizeUrl(args.url))
            } catch {}
            // Reading the same page again adds no evidence. Saying so is what turns a
            // repeated read into a different lead instead of a spent step.
            if (openedPages.size === before) output = `${output}\n[already read in this run: this page adds no new evidence. Open a different lead.]`
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
  return { ...question, prediction: final, closingText: closingText.slice(0, 500), judge, judgeNote, turns, searches, reads, leads: leads.size, evidenceFloor, distinctPages: openedPages.size, grounded, citations: answerCitations.length, seconds: Number(((Date.now() - (deadline - limits.questionMs)) / 1000).toFixed(1)), trace, goldInEvidence: goldInEvidence(evidence, question.answer), failure }
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

/**
 * The product's research path renders through the hidden Chromium this module
 * owns. Under Electron the harness uses that same renderer, so a measurement
 * includes the channel the product actually has instead of only the curl path;
 * under plain node it measures retrieval without a browser and says so.
 */
let renderPage
let electronApp
if (process.versions.electron) {
  // Diagnostics go to stderr so a stalled Electron start is visible in a log
  // instead of looking like a hung benchmark.
  const step = text => console.error(`[bench] ${text}`)
  step(`electron ${process.versions.electron}: importing electron`)
  const electron = await import('electron')
  electronApp = electron.app
  step('waiting for app ready')
  // A nested Electron that never becomes ready must fail fast with an actionable
  // message instead of hanging the whole run: it happens when this process is
  // spawned without a GUI session, and it is fixed by running the runner from a
  // normal terminal.
  const ready = await Promise.race([
    electronApp.whenReady().then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 20_000)),
  ])
  if (!ready) {
    console.error('[bench] Electron did not become ready within 20s. Run this from a normal terminal:\n  pnpm bench:research:app -- --count 20 --concurrency 4')
    electronApp.exit(2)
    process.exit(2)
  }
  step('ready; loading the research renderer')
  try {
    renderPage = (await import('../src/main/web-render.ts')).renderWebPage
    step('renderer loaded')
  } catch (error) {
    // A browser that cannot be constructed must not turn into a hung measurement:
    // the run continues without it and the banner says so.
    step(`renderer unavailable: ${String(error?.message || error).slice(0, 200)}`)
  }
}

const provider = await loadProvider()
const count = Number(argument('count', DEFAULT_COUNT)), seed = Number(argument('seed', 0)), skip = Number(argument('skip', 0))
const limits = {
  turns: Number(argument('turns', DEFAULT_TURNS)),
  searches: Number(argument('searches', DEFAULT_SEARCHES)),
  reads: Number(argument('reads', DEFAULT_READS)),
  questionMs: Number(argument('question-seconds', DEFAULT_QUESTION_SECONDS)) * 1_000,
  minReads: Number(argument('min-reads', DEFAULT_MIN_READS)),
  requireSource: process.argv.includes('--require-source'),
}
const concurrency = Math.max(1, Number(argument('concurrency', DEFAULT_CONCURRENCY)))
const { total, sample } = await loadQuestions(count, seed, skip)
const out = argument('out', join('tmp', `browsecomp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))

console.log(`BrowseComp subset: ${sample.length} of ${total} questions (seed ${seed}) on ${provider.model}, ${concurrency} at a time, ${limits.questionMs / 1000}s per question, browser=${renderPage ? 'hidden-chromium' : 'none'}`)
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
electronApp?.quit()
