/**
 * Does researching several lines at once beat researching them in one context?
 *
 * The product has `research_fanout` and the BrowseComp harness never used it, so the shape the
 * product runs in parallel had no measurement at all — while a person watching a fan-out could
 * see, without measuring, that its findings looked thinner than what one context brought back.
 *
 * This harness measures the shape on cases chosen for it. A case is one question holding several
 * independent lookups, each with its own short gold answer, so "did the run answer part 3" is a
 * fact rather than a judgement. Every arm sees the same question text, the same tools, the same
 * total call budget and the same closing instruction; what differs is only how the reading is
 * organised, and, for the last arm, the research contract each line is given.
 *
 *   node --experimental-strip-types scripts/research-fanout-bench.mjs \
 *     [--groups 2] [--parts 3] [--arms single,fanout,fanout-contract] [--seed 0] \
 *     [--turns 8] [--searches 2] [--reads 3] [--line-parallel 3] [--out tmp/fanout.json]
 *
 * Arms:
 *   single            one context answers every part, with the calls all the lines would have had
 *   single-default    one context answers every part on the product's own single-line budget
 *   fanout            one context per part, its findings handed to a lead agent that answers
 *   fanout-plain      the same, each line given only "research this line" and no research rules
 *   fanout-contract   the same, each line given the research contract Shun gives an explorer
 *
 * Effort is matched by default because token spend is the dominant term in retrieval performance:
 * an arm that is handed four times the calls and loses anyway has lost on shape, not on budget.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { answerMatches, goldInEvidence, goldTokenRate, loadQuestions } from './browsecomp-dataset.mjs'
import { cleanAnswer, isToolMarkupReply, looksLikeAnswer } from './bench-answer.mjs'
import { webEvidenceGuidance, webSearchGroundRules, webSourceLadder } from '../src/main/capabilities.ts'
import { explorerReadGate } from '../src/main/web-research-policy.ts'
import { readWeb, searchWeb } from '../src/main/web.ts'

const DEFAULTS = { groups: 2, parts: 3, turns: 8, searches: 3, reads: 5, lineParallel: 3, questionSeconds: 900 }

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
  throw Error('No provider: set SHUN_BENCH_ENDPOINT, SHUN_BENCH_API_KEY and SHUN_BENCH_MODEL, or run the app once to write its settings.')
}

function messageText(message) {
  const raw = String(message?.content ?? '')
  // A provider that answered entirely in the reasoning channel still answered.
  return isToolMarkupReply(raw) ? '' : raw
}

async function chat(provider, messages, tools, maxTokens = 16_000) {
  const call = async () => {
    const response = await fetch(`${provider.endpoint.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify({ model: provider.model, messages, ...(tools?.length ? { tools } : {}), temperature: 0.2, max_tokens: maxTokens }),
    })
    if (!response.ok) throw Error(`model call failed: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`)
    const payload = await response.json(), choice = payload.choices?.[0], message = choice?.message
    if (!message) throw Error(`model returned no message: ${JSON.stringify(payload).slice(0, 300)}`)
    message.finish_reason = choice?.finish_reason
    message.usage = payload.usage || {}
    return message
  }
  // A provider under load refuses rather than answers, and a refused call is not a research result:
  // it is retried with room for the pressure to pass, because an arm that lost its first turn to a
  // 429 would be measured as an arm that found nothing.
  const delays = [2_000, 8_000, 20_000, 40_000]
  for (let attempt = 0; ; attempt++) {
    try { return await call() } catch (error) {
      const message = String(error?.message || error)
      const transient = /HTTP (?:429|500|502|503|504)|fetch failed|network|ECONN|timeout/i.test(message)
      if (!transient || attempt >= delays.length) throw error
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
}

/** One tool description surface, shared by every arm: an arm differs in its rules, not its tools. */
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web for candidate URLs. Returns ranked results with a title, a snippet, a source class and a confidence for each: direct means the result sits on the query subject\u2019s own domain, lead means it only mentions the clues.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query, under six words.' },
          site: { type: 'string', description: 'Optional host or host/path to restrict the search to.' },
          exact_phrases: { type: 'array', items: { type: 'string' }, description: 'Optional quoted phrases a result must contain.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_read',
      description: 'Open one public URL and return its readable text, with the sections carrying the query\u2019s words put in front of the page top, plus the outbound links ranked by the same words.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          query: { type: 'string', description: 'What you are looking for on this page: it ranks the returned excerpts and the outbound links.' },
          max_chars: { type: 'integer' },
          offset: { type: 'integer' },
        },
        required: ['url'],
      },
    },
  },
]

/**
 * The neutral research rules every arm runs under, mirrored from the harness that measured the
 * product's single-line path: whichever arm is being measured, it is measured doing the same
 * research with the same instructions, so an arm cannot win by being told more.
 */
const NEUTRAL_RULES = [
  'Answer the question below by researching the public web with the provided tools.',
  'Keep search queries short — under six words. A search engine matches the words a page contains, and a page states a fact in a few words, not in the sentence describing it. If a short query returns too little, change the words rather than lengthening the query.',
  'Work clue by clue: the question states several constraints, and the answer is what satisfies all of them at once.',
  'A search that returns nothing means the words were wrong, not that the fact is unlisted: restate the same clue with the words the page holding it would use, ask an encyclopedia for the subject, or follow the pages you did open to the ones they link.',
  'A clue is established only when a page you opened states it. Plausible, familiar, or remembered is not established, and neither is a name that merely appears in a search snippet you never opened.',
  'Before answering, check the candidate against every clue. When one clue is not established, that is the next search, never something the answer talks around.',
  'The answer must satisfy every clue together. Candidates that explain most clues and ignore one are wrong, not close.',
]

/** What the product tells one parallel explorer: the rules the session itself gets, plus the ladder. */
function contractRules(request) {
  return [
    'You are a research explorer: another agent opened this one line of inquiry because it cannot read in several directions at once, and this context window is yours alone. The lead agent sees only what you report back.',
    `The person’s request, which your line serves: ${request}`,
    ...webSearchGroundRules,
    ...webSourceLadder,
    webEvidenceGuidance,
    'Work from pages rather than from result lists, because only a page you opened can establish anything: open the strongest lead before you report, and follow the links it carries before searching again.',
    'Report in this shape: the answer to the line first, in one sentence; then each fact that supports it, with the exact source URL that states it and the kind of source it is; then what stayed open.',
  ]
}

/** The bare instruction the explorer used to get: one line of inquiry and nothing about how to work it. */
const BARE_LINE_RULES = [
  'You are a research explorer working one line of inquiry for another agent.',
  'Search the web, open the pages behind the strongest leads, and follow their references.',
  'Report only what you established: the finding, the exact source URL that supports it, and what you could not establish.',
]

function caseQuestion(items) {
  return [
    `Answer each of these ${items.length} questions. They are independent, and each has its own short answer.`,
    ...items.map((item, index) => `${index + 1}. ${item.problem}`),
    `Finish with ${items.length} lines and nothing else: ${items.map((_, index) => `"ANSWER ${index + 1}: <short answer>"`).join(', ')}`,
  ].join('\n')
}

/**
 * A case is only worth measuring when its parts are reachable inside the budget being measured.
 * BrowseComp is built so that a handful of searches cannot find an answer, which makes it the
 * right substrate for a long-line benchmark and the wrong one for a benchmark that has to be
 * cheap: an arm cannot be compared with another arm on a part neither of them could have
 * answered, and both would score zero for a reason that has nothing to do with the shape.
 *
 * Screening is therefore part of building the case set, not a filter on the results: each
 * candidate part is searched once with the words the question names, and it is kept only when the
 * page that carries its answer shows up in the first result set. What remains is a set of parts a
 * line can settle by reading rather than by hunting, which is what a parallel lookup is for.
 */
async function screenParts(items, renderPage, budget = { searches: 2, reads: 1 }) {
  const kept = []
  for (const item of items) {
    const named = [...new Set(String(item.problem).replace(/[^\p{L}\p{N} ]+/gu, ' ').split(/\s+/).filter(word => word.length > 3 && !/^(?:which|what|whose|this|that|with|from|that|they|their|would|about|following)$/i.test(word)))]
    const queries = [named.slice(0, 5).join(' '), named.slice(-5).join(' '), named.slice(0, 2).join(' ')].filter(query => query.length > 3)
    const evidence = []
    let reached = 0
    for (const query of queries.slice(0, budget.searches)) {
      try {
        const results = JSON.parse(await searchWeb(query, 8, { renderPage })).results || []
        evidence.push(JSON.stringify(results))
        reached = Math.max(reached, goldTokenRate(evidence, item.answer))
        // The answer being in a snippet is enough to call the part reachable: a line that sees it
        // has somewhere to read, which is what decides whether a shape can answer at all.
        if (reached >= 0.6 || goldInEvidence(evidence, item.answer)) {
          const url = results[0]?.url || results[1]?.url
          if (url && budget.reads) {
            try { evidence.push(await readWeb(url, undefined, renderPage, undefined, undefined, String(item.problem).slice(0, 200))) } catch {}
            reached = Math.max(reached, goldTokenRate(evidence, item.answer))
          }
          break
        }
      } catch {}
    }
    if (reached >= 0.6 || goldInEvidence(evidence, item.answer)) kept.push({ ...item, screenReach: Number(reached.toFixed(2)) })
  }
  return kept
}

/**
 * Cases are built so the parts are genuinely independent lookups: one part per subject, taken
 * round-robin across the subjects in the sample, so no case is one subject split several ways.
 */
async function buildCases(groups, parts, seed, renderPage) {
  const { total, sample } = await loadQuestions(Math.min(200, groups * parts * 4), seed)
  const reachable = process.argv.includes('--screen') ? await screenParts(sample, renderPage) : sample
  const buckets = new Map()
  for (const item of reachable) {
    const list = buckets.get(item.topic) || []
    list.push(item)
    buckets.set(item.topic, list)
  }
  const cases = Array.from({ length: groups }, () => [])
  for (const item of [...buckets.values()].flat()) {
    const shortest = cases.reduce((best, current) => current.length < best.length ? current : best)
    if (shortest.length < parts) shortest.push(item)
  }
  return { total, screened: reachable.length, cases: cases.filter(items => items.length >= 2).map((items, index) => ({ id: `case-${index + 1}`, items })) }
}

function toolCalls(reply) {
  const calls = Array.isArray(reply?.tool_calls) ? reply.tool_calls : []
  return calls.flatMap(call => {
    const name = String(call?.function?.name || '')
    if (name !== 'web_search' && name !== 'web_read') return []
    let args = {}
    try { args = JSON.parse(String(call?.function?.arguments || '{}')) } catch { args = {} }
    return [{ id: String(call?.id || `call-${Math.random().toString(36).slice(2)}`), name, args }]
  })
}

const blocked = (state, note) => JSON.stringify({ ok: false, blocked: true, note: `${note} Nothing was fetched, so this says nothing about the subject.` })

/**
 * One context doing research: the same loop for the single arm and for a fan-out line, so the only
 * difference between them is the context they run in and the rules they were given.
 */
async function runContext(provider, { system, question, budget, parts, gate, renderPage, deadline }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: question }]
  const evidence = [], trace = []
  const counts = { searches: 0, reads: 0, chats: 0, blocked: 0, failed: 0, steers: 0, promptTokens: 0, completionTokens: 0 }
  const diagnostics = []
  const started = Date.now()
  let closed = ''
  const bill = reply => { counts.promptTokens += Number(reply?.usage?.prompt_tokens) || 0; counts.completionTokens += Number(reply?.usage?.completion_tokens) || 0 }
  for (let turn = 0; turn < budget.turns; turn++) {
    if (Date.now() - started > deadline) { closed = 'time limit'; break }
    let reply
    try { reply = await chat(provider, messages, TOOLS); counts.chats++; bill(reply) } catch (error) { counts.failed++; closed = String(error?.message || error).slice(0, 200); break }
    // A turn cut off at the token limit wrote no tool call and no reply: it is retried with room to
    // finish, and then told to act, because a context that deliberated its whole budget has not
    // decided to stop researching — it has not finished deciding to start. Both the product's own
    // harness and the field's agents close a turn this way; a run that never acts would be scored
    // as an arm that found nothing, which is a measurement of the provider, not of the shape.
    for (let attempt = 0; attempt < 2 && reply.finish_reason === 'length' && !toolCalls(reply).length; attempt++) {
      const nudge = attempt === 0
        ? 'Your previous turn ran out of length before it acted. Call the next tool now with a short query.'
        : 'Do not deliberate. Call web_search or web_read now, in this turn, and nothing else.'
      messages.push({ role: 'user', content: nudge })
      try { reply = await chat(provider, messages, TOOLS, attempt === 0 ? 24_000 : 24_000); counts.chats++; bill(reply); diagnostics.push({ turn, nudged: attempt + 1, finish: reply.finish_reason, contentChars: String(reply.content || '').length, toolCalls: Array.isArray(reply.tool_calls) ? reply.tool_calls.length : 0 }) } catch { break }
    }
    const calls = toolCalls(reply)
    diagnostics.push({ turn, finish: reply.finish_reason, contentChars: String(reply.content || '').length, toolCalls: Array.isArray(reply.tool_calls) ? reply.tool_calls.length : 0 })
    messages.push({ role: 'assistant', content: messageText(reply), ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) })
    if (!calls.length) {
      // A context that has searched and opened nothing has not researched anything. The product
      // holds a session to this rule and now holds an explorer to it too; every arm here is held
      // to it, so no arm wins by being the one that was told to read.
      if (counts.steers < 1 && counts.searches > 0 && counts.reads === 0) {
        counts.steers++
        messages.push({ role: 'user', content: 'You have run searches and opened none of the pages they returned. Open the strongest URL you already have with web_read, pass the identifying clue as its query so its outbound links are ranked first, and follow what that page points to before searching again.' })
        continue
      }
      break
    }
    for (const call of calls) {
      const at = Date.now()
      const gateVerdict = call.name === 'web_search' ? await (gate?.({ toolCall: { name: call.name } }) ?? Promise.resolve(undefined)) : undefined
      let output = '', note = ''
      if (gateVerdict?.block) { counts.blocked++; note = 'blocked by the read rule'; output = blocked('blocked', gateVerdict.reason) }
      else if (call.name === 'web_search' && counts.searches >= budget.searches) { counts.blocked++; note = 'line search budget spent'; output = blocked('spent', 'This search did not go out: this line has already run as many searches as it has room for.') }
      else if (call.name === 'web_read' && counts.reads >= budget.reads) { counts.blocked++; note = 'line read budget spent'; output = blocked('spent', 'This read did not go out: this line has already opened as many pages as it has room for.') }
      else {
        try {
          if (call.name === 'web_search') {
            counts.searches++
            output = await searchWeb(String(call.args.query || ''), 5, { renderPage, site: call.args.site ? String(call.args.site) : undefined, exactPhrases: Array.isArray(call.args.exact_phrases) ? call.args.exact_phrases.map(String) : undefined })
          } else {
            counts.reads++
            output = await readWeb(String(call.args.url || ''), call.args.max_chars, renderPage, call.args.offset, undefined, call.args.query)
          }
        } catch (error) { counts.failed++; note = String(error?.message || error).slice(0, 120); output = JSON.stringify({ ok: false, error: note }) }
      }
      evidence.push(output)
      trace.push({ tool: call.name, seconds: Math.round((Date.now() - at) / 1000), note, url: call.name === 'web_read' ? String(call.args.url || '') : '' })
      messages.push({ role: 'tool', tool_call_id: call.id, content: output.slice(0, 12_000) })
    }
  }
  const answer = await closingAnswer(provider, messages, parts, deadline - (Date.now() - started))
  return { messages, evidence, trace, counts, diagnostics, answer, seconds: Math.round((Date.now() - started) / 1000), closed, openedUrls: trace.map((step, index) => step.tool === 'web_read' ? step.url : '').filter(Boolean) }
}

/**
 * The closing turn, identical in every arm: one line per part, parsed per part so a run that
 * answered three of four parts scores as three, not as one guess about a blob of text.
 */
async function closingAnswer(provider, messages, parts, remainingMs) {
  const wanted = `Reply with exactly ${parts} lines and nothing else: ${Array.from({ length: parts }, (_, index) => `ANSWER ${index + 1}: <short answer>`).join(', ')}. Write "ANSWER ${parts}: unestablished" for any part no page established, and do not write tool calls as text.`
  const instruction = [
    'Stop deliberating now. From the evidence in this conversation, answer every part in order.',
    'Name the URL that states each answer, or say the part is unestablished.',
    wanted,
  ].join(' ')
  let fallback = '', text = ''
  const attempts = []
  for (const [maxTokens, prompt] of [[6_000, instruction], [16_000, instruction], [24_000, `Do not explain. ${wanted}`]]) {
    if (remainingMs !== undefined && remainingMs < 5_000) { attempts.push({ maxTokens, skipped: 'out of time' }); break }
    let reply
    try { reply = await chat(provider, [...messages, { role: 'user', content: prompt }], undefined, maxTokens) } catch (error) { attempts.push({ maxTokens, error: String(error?.message || error).slice(0, 120) }); continue }
    const content = messageText(reply)
    // A thinking model can put the whole closing turn in the reasoning channel, and a closing
    // turn that only deliberated is not an answer: it is recorded as one and scored as none.
    attempts.push({ maxTokens, finish: reply.finish_reason, contentChars: content.length, reasoningChars: String(reply.reasoning_content || '').length })
    if (!content) continue
    text = content
    const parsed = parseAnswerLines(content)
    if (parsed.size === parts) return { lines: parsed, text: content, attempts }
    if (!fallback && looksLikeAnswer(cleanAnswer(content))) fallback = content
  }
  return { lines: parseAnswerLines(text), text: fallback || text, attempts }
}

function parseAnswerLines(text) {
  const lines = new Map()
  for (const match of String(text || '').matchAll(/ANSWER\s*(\d{1,2})\s*[:：]\s*([^\n]*)/gi)) {
    const index = Number(match[1]), value = cleanAnswer(match[2]) || String(match[2] || '').trim()
    if (!lines.has(index) && value) lines.set(index, value)
  }
  return lines
}

/**
 * Grading follows the field's own practice rather than the harness's convenience. OpenAI's
 * BrowseComp grader is an LLM asked to extract the run's answer and judge it against the known
 * correct answer, because a run can be right in a form a string match refuses; Anthropic graded
 * research agents with one judge call over a fixed rubric — factual accuracy, citation accuracy,
 * completeness, source quality, and tool efficiency — because research output is free-form and
 * rarely has one correct wording.
 *
 * Both are one call per run here, on the run's final answer alone, blind to which arm produced it,
 * and asked for per-part verdicts in the same JSON, so the judge cannot favour an arm it recognises
 * and cannot be the expensive part of the measurement.
 */
function judgePrompt(case_, answer, openedUrls) {
  return [
    'You are grading one research run. Do not solve the problem yourself, do not argue for an answer other than the known one, and judge only whether the run\u2019s answer matches the known correct answer for each part.',
    `The question the run was asked, in ${case_.items.length} parts:`,
    ...case_.items.map((item, index) => `${index + 1}. ${item.problem}`),
    'The known correct answer for each part:',
    ...case_.items.map((item, index) => `${index + 1}. ${item.answer}`),
    'The run\u2019s final answer:',
    String(answer || '(no answer was produced)').slice(0, 6_000),
    `The pages the run opened (${openedUrls.length}):`,
    ...[...new Set(openedUrls)].slice(0, 40),
    'Judge each part: extract the run\u2019s final answer for it, and say yes when it matches the known answer or is within a small margin of error for a number, and no when it is missing, inconsistent, ambiguous, or not equivalent. Put "None" as the extracted answer when the run gave none for that part.',
    'Then grade the run as a whole against these criteria, each from 0.0 to 1.0:',
    'factual_accuracy: do the claims match the sources the run opened, rather than its own memory or a plausible guess?',
    'citation_accuracy: do the sources the run names actually support the claims it makes?',
    'completeness: are all the parts answered?',
    'source_quality: did it answer from primary sources — the thing itself, its own record, a first-party account — rather than from secondary commentary about it, such as papers, aggregators, listicles, or pages written to match the query?',
    'tool_efficiency: did it search and read a reasonable number of times for what was asked, without repeating the same query or opening pages that could not help?',
    'Reply with JSON only, no prose and no code fences:',
    '{"parts":[{"part":1,"extracted_final_answer":"...","correct":"yes|no"}],"factual_accuracy":0.0,"citation_accuracy":0.0,"completeness":0.0,"source_quality":0.0,"tool_efficiency":0.0,"pass":true|false,"reason":"..."}',
  ].join('\n')
}

async function judgeRun(provider, case_, answer, openedUrls) {
  try {
    let reply = await chat(provider, [{ role: 'user', content: judgePrompt(case_, answer, openedUrls) }], undefined, 6_000)
    // A thinking judge can spend its first reply's whole budget deliberating and write no JSON.
    if (!String(reply.content || '').trim()) reply = await chat(provider, [{ role: 'user', content: judgePrompt(case_, answer, openedUrls) }], undefined, 16_000)
    const text = String(reply.content || '').replace(/^```(?:json)?|```$/gm, ' ').trim()
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    const parts = Array.isArray(parsed.parts) ? parsed.parts : []
    const verdicts = case_.items.map((item, index) => {
      const row = parts.find(entry => Number(entry?.part) === index + 1)
      return { part: index + 1, gold: item.answer, correct: row?.correct === 'yes', extracted: String(row?.extracted_final_answer || '').slice(0, 90) }
    })
    return {
      verdicts,
      rubric: {
        factual_accuracy: Number(parsed.factual_accuracy) || 0,
        citation_accuracy: Number(parsed.citation_accuracy) || 0,
        completeness: Number(parsed.completeness) || 0,
        source_quality: Number(parsed.source_quality) || 0,
        tool_efficiency: Number(parsed.tool_efficiency) || 0,
        pass: parsed.pass === true,
        reason: String(parsed.reason || '').slice(0, 240),
      },
      failed: false,
    }
  } catch (error) {
    // A judge that cannot run is reported as a missing judgement, never as a run that answered
    // nothing: the deterministic per-part match still stands on its own.
    return { verdicts: [], rubric: null, failed: String(error?.message || error).slice(0, 160) }
  }
}

/** Per part: the gold answer met, the share of its tokens ever retrieved, and the line that claimed it. */
function score(case_, answer, evidence, extra = {}) {
  const parts = case_.items.map((item, index) => {
    const predicted = answer.lines.get(index + 1) || ''
    const matched = predicted ? answerMatches(predicted, item.answer) : false
    return {
      part: index + 1,
      gold: item.answer,
      predicted: predicted.slice(0, 90),
      matched,
      // A run that answered in prose rather than in marked lines can still be right.
      matchedInProse: answerMatches(answer.text, item.answer),
      goldTokenRate: Number(goldTokenRate(evidence, item.answer).toFixed(3)),
      goldInEvidence: goldInEvidence(evidence, item.answer),
    }
  })
  const answered = parts.filter(part => part.matched || part.matchedInProse).length
  return { id: case_.id, coverage: Number((answered / parts.length).toFixed(3)), answered, parts, ...extra }
}

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

/**
 * A fan-out as the product runs it: one context per line, at most `lineParallel` of them at once,
 * and a lead agent that receives the lines' findings — compressed, not their reading — and answers.
 */
async function runFanout(provider, { case_, rules, partsBudget, arm, renderPage, deadline }) {
  const question = caseQuestion(case_.items)
  const lines = case_.items.map((item, index) => case_.items.length > 1 ? `${item.problem}` : item.problem)
  const started = Date.now()
  const gate = explorerReadGate()
  const runs = await runWithConcurrency(lines.map((line, index) => ({ line, index })), Math.max(1, Number(argument('line-parallel', DEFAULTS.lineParallel))), async item =>
    await runContext(provider, { system: rules(question, item.index), question: `Research this line of inquiry and report what you establish.\n\nLine: ${item.line}`, budget: partsBudget, parts: 1, gate, renderPage, deadline }))
  const findings = runs.map((run, index) => `### ${case_.items[index].problem}\n${(run.answer.text || '').slice(0, 4_000) || '[the explorer returned no finding]'}`).join('\n\n')
  const lineClosing = runs.map(run => run.answer.attempts)
  const lead = [
    NEUTRAL_RULES[0],
    'Another agent has already researched this in parallel and the findings below are all the evidence you get. You have no tools: answer from these findings.',
    'Where a finding names the source it came from, keep the answer at that confidence rather than raising it.',
  ].join(' ')
  const leadMessages = [
    { role: 'system', content: lead },
    { role: 'user', content: question },
    { role: 'user', content: `Findings from the parallel explorers:\n\n${findings}` },
  ]
  const answer = await closingAnswer(provider, leadMessages, case_.items.length, deadline - (Date.now() - started))
  return {
    answer,
    evidence: runs.flatMap(run => run.evidence),
    counts: runs.reduce((total, run) => ({ searches: total.searches + run.counts.searches, reads: total.reads + run.counts.reads, chats: total.chats + run.counts.chats, blocked: total.blocked + run.counts.blocked, failed: total.failed + run.counts.failed, steers: total.steers + run.counts.steers, promptTokens: total.promptTokens + run.counts.promptTokens, completionTokens: total.completionTokens + run.counts.completionTokens }), { searches: 0, reads: 0, chats: 0, blocked: 0, failed: 0, steers: 0, promptTokens: 0, completionTokens: 0 }),
    diagnostics: runs.map(run => run.diagnostics),
    seconds: Math.round((Date.now() - started) / 1000),
    lineCoverage: runs.map((run, index) => ({ part: index + 1, matched: answerMatches(run.answer.text || '', case_.items[index].answer), chars: (run.answer.text || '').length, closed: run.closed || '' })),
    lineClosing,
    findings,
    openedUrls: runs.flatMap(run => run.openedUrls || []),
  }
}

const provider = await loadProvider()
const groups = Number(argument('groups', DEFAULTS.groups)), parts = Number(argument('parts', DEFAULTS.parts)), seed = Number(argument('seed', 0))
const arms = String(argument('arms', 'single,fanout,fanout-contract')).split(',').map(arm => arm.trim()).filter(Boolean)
const perLine = {
  turns: Number(argument('turns', DEFAULTS.turns)),
  searches: Number(argument('searches', DEFAULTS.searches)),
  reads: Number(argument('reads', DEFAULTS.reads)),
}
const questionMs = Number(argument('question-seconds', DEFAULTS.questionSeconds)) * 1_000

let renderPage
if (process.argv.includes('--headless-chrome')) {
  const { createHeadlessChromeRenderer } = await import('./headless-render.mjs')
  renderPage = createHeadlessChromeRenderer().renderPage
}

const { total, screened, cases } = await buildCases(groups, parts, seed, renderPage)
console.log(`fan-out benchmark: ${cases.length} cases of up to ${parts} independent parts (from ${total} BrowseComp rows, ${screened} reachable, seed ${seed}) on ${provider.model}`)
console.log(`per-part budget: ${perLine.searches} searches / ${perLine.reads} reads / ${perLine.turns} turns; arms: ${arms.join(', ')}; browser=${renderPage ? 'headless-chrome' : 'none'}\n`)

const report = { model: provider.model, seed, parts, arms, perLine, browser: Boolean(renderPage), cases: [] }
for (const case_ of cases) {
  console.log(`── ${case_.id}: ${case_.items.map(item => item.topic).join(', ')}`)
  // Arms run one after another: they are minutes of model time each, and a provider asked for eight
  // sessions at once answers some of them with a refusal, which would be measured as an arm that
  // found nothing. The fan-out's own lines still run in parallel, because that is the shape.
  const runs = {}
  for (const arm of arms) {
    const deadline = questionMs
    const started = Date.now()
    let result
    let runError = ''
    if (arm === 'single' || arm === 'single-default') {
      const budget = arm === 'single'
        // Effort matched: one context is handed the calls every line would have had.
        ? { turns: perLine.turns * case_.items.length, searches: perLine.searches * case_.items.length, reads: perLine.reads * case_.items.length }
        // The product's own single-line ceiling for one research phase.
        : { turns: perLine.turns, searches: 6, reads: 8 }
      const run = await runContext(provider, { system: NEUTRAL_RULES.join(' '), question: caseQuestion(case_.items), budget, parts: case_.items.length, gate: explorerReadGate(), renderPage, deadline })
      result = { answer: run.answer, evidence: run.evidence, counts: run.counts, diagnostics: run.diagnostics, seconds: run.seconds, lineCoverage: [], trace: [], openedUrls: run.openedUrls, closed: run.closed }
      runError = run.closed
    } else {
      const rules = (question, index) => {
        const line = `${case_.items[index].problem}`
        if (arm === 'fanout-plain') return BARE_LINE_RULES.join(' ')
        if (arm === 'fanout-contract') return contractRules(`${question}\nYour line is: ${line}`).join('\n')
        return [...NEUTRAL_RULES, 'You are working one line of inquiry of a larger question, and another agent will combine your finding with others.'].join(' ')
      }
      result = await runFanout(provider, { case_, rules, partsBudget: perLine, arm, renderPage, deadline })
    }
    const judged = await judgeRun(provider, case_, result.answer.text, result.openedUrls || [])
    const scored = score(case_, result.answer, result.evidence, {
      arm,
      seconds: result.seconds,
      counts: result.counts,
      lineCoverage: result.lineCoverage,
      closing: result.answer.attempts,
      diagnostics: result.diagnostics,
      judge: judged.verdicts,
      rubric: judged.rubric,
      judgeError: judged.failed || '',
      runError,
      ...(result.findings ? { findings: result.findings } : {}),
      elapsed: Math.round((Date.now() - started) / 1_000),
    })
    // The judge decides whether a part was answered; the string match is kept beside it because the
    // two disagreeing is itself a finding about the answer's form, not about the research.
    for (const part of scored.parts) {
      const verdict = (judged.verdicts || []).find(row => row.part === part.part)
      part.judgedCorrect = verdict ? verdict.correct : undefined
    }
    scored.judgedAnswered = scored.parts.filter(part => part.judgedCorrect === true).length
    runs[arm] = scored
    console.log(`   ${arm.padEnd(16)} judged ${scored.judgedAnswered}/${case_.items.length}${judged.rubric ? ` | rubric source=${judged.rubric.source_quality.toFixed(1)} complete=${judged.rubric.completeness.toFixed(1)} pass=${judged.rubric.pass ? 'yes' : 'no '}` : ` | judge failed: ${judged.failed}`} | string-match ${scored.answered}/${case_.items.length} | reach ${(scored.parts.reduce((sum, part) => sum + part.goldTokenRate, 0) / scored.parts.length * 100).toFixed(0)}%`)
    console.log(`      ${result.counts.searches}s/${result.counts.reads}r, ${result.counts.chats} chats, ${result.counts.blocked} blocked, ${result.counts.failed} failed, ${Math.round((result.counts.promptTokens + result.counts.completionTokens) / 1000)}k tokens | ${scored.seconds}s${runError ? ` | stopped: ${runError}` : ''}`)
    if (!result.counts.searches && !result.counts.reads) console.log(`      no tool call was made: ${JSON.stringify((result.diagnostics || []).slice(0, 2))}`)
  }
  report.cases.push({ id: case_.id, topics: case_.items.map(item => item.topic), questions: case_.items.map(item => item.problem), answers: case_.items.map(item => item.answer), runs })
}

const summary = arms.map(arm => {
  const scored = report.cases.map(item => item.runs[arm])
  const partsTotal = scored.reduce((sum, run) => sum + run.parts.length, 0)
  const judged = scored.reduce((sum, run) => sum + (run.judgedAnswered || 0), 0)
  const rubrics = scored.map(run => run.rubric).filter(Boolean)
  const mean = key => rubrics.length ? Number((rubrics.reduce((sum, rubric) => sum + rubric[key], 0) / rubrics.length).toFixed(2)) : null
  return {
    arm,
    judgedParts: `${judged}/${partsTotal}`,
    judgedAccuracy: Number((judged / partsTotal).toFixed(3)),
    stringMatched: `${scored.reduce((sum, run) => sum + run.answered, 0)}/${partsTotal}`,
    reachMean: Number((scored.reduce((sum, run) => sum + run.parts.reduce((partSum, part) => partSum + part.goldTokenRate, 0), 0) / partsTotal).toFixed(3)),
    factualAccuracy: mean('factual_accuracy'),
    citationAccuracy: mean('citation_accuracy'),
    completeness: mean('completeness'),
    sourceQuality: mean('source_quality'),
    toolEfficiency: mean('tool_efficiency'),
    passes: `${rubrics.filter(rubric => rubric.pass).length}/${rubrics.length}`,
    judgedRuns: rubrics.length,
    searches: scored.reduce((sum, run) => sum + run.counts.searches, 0),
    reads: scored.reduce((sum, run) => sum + run.counts.reads, 0),
    tokens: Math.round(scored.reduce((sum, run) => sum + run.counts.promptTokens + run.counts.completionTokens, 0) / 1000),
    failed: scored.reduce((sum, run) => sum + run.counts.failed, 0),
    secondsMean: Math.round(scored.reduce((sum, run) => sum + run.seconds, 0) / scored.length),
  }
})
report.summary = summary

const out = argument('out', join('tmp', `fanout-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(report, null, 2))
console.log('\n── summary (judge on the final answer, blind to the arm)')
console.log('arm               judged     reach  factual  cite  complete  source  tools  pass   search read tokens   sec')
for (const row of summary) {
  const score = value => value === null ? '  n/a' : value.toFixed(2).padStart(5)
  console.log(`${row.arm.padEnd(16)} ${row.judgedParts.padEnd(9)} ${(row.reachMean * 100).toFixed(0).padStart(5)}% ${score(row.factualAccuracy)} ${score(row.citationAccuracy)} ${score(row.completeness).padStart(9)} ${score(row.sourceQuality).padStart(7)} ${score(row.toolEfficiency).padStart(6)} ${row.passes.padStart(5)} ${String(row.searches).padStart(7)} ${String(row.reads).padStart(4)} ${String(row.tokens).padStart(5)}k ${String(row.secondsMean).padStart(5)}`)
}
console.log(`report: ${out}`)
process.exit(0)
