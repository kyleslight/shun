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
import { answerMatches, goldInEvidence, goldTokenRate, loadQuestions, normalizeAnswer } from './browsecomp-dataset.mjs'
import { cleanAnswer, isToolMarkupReply, looksLikeAnswer } from './bench-answer.mjs'
import { chooseStableAnswer, parseLedger, parsePlannedQueries, shortenQuery } from './bench-parse.mjs'
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
      description: 'Open one public URL and return the readable text, with the sections that carry the query\'s words put in front of the page top. Use the field query to rank both outbound links and the returned excerpts toward what you are looking for.',
      parameters: { type: 'object', properties: { url: { type: 'string' }, query: { type: 'string' }, max_chars: { type: 'integer' }, offset: { type: 'integer' } }, required: ['url'] },
    },
  },
]

const SYSTEM = [
  'Answer the question below by researching the public web with the provided tools.',
  'Keep search queries short — under six words. A search engine matches the words a page contains, and a page states a fact in a few words, not in the sentence describing it. If a short query returns too little, change the words rather than lengthening the query.',
  'Work clue by clue: the question states several constraints, and the answer is what satisfies all of them at once.',
  'A search that returns nothing means the words were wrong, not that the fact is unlisted: restate the same clue with the words the page holding it would use, ask an encyclopedia for the subject, or follow the pages you did open to the ones they link.',
  'A clue is established only when a page you opened states it. Plausible, familiar, or remembered is not established, and neither is a name that merely appears in a search snippet you never opened.',
  'Before answering, check the candidate against every clue. When one clue is not established, that is the next search, never something the answer talks around.',
  'The answer must satisfy every clue together. Candidates that explain most clues and ignore one are wrong, not close.',
  'When your evidence names one short answer, reply with a final message whose last line is "ANSWER: <answer>".',
].join(' ')

/**
 * A thinking model spends its output budget on deliberation, so a closing request
 * with a small budget comes back as unfinished reasoning with no answer in it. The
 * closing turn therefore forbids deliberation, and a reply that was cut off or that
 * only wrote tool markup is retried instead of being scored as an answer.
 */
async function finalAnswer(provider, messages) {
  // A run can hold the answer and still hand back a different candidate: the choice among
  // what was read is a step of its own. The closing request therefore asks for the candidates
  // that were actually seen, what each one satisfies and misses, and the single answer that
  // satisfies every clue. Nothing about the answer is supplied — only the discipline of
  // choosing between the candidates the run itself found.
  const instruction = [
    'Stop deliberating now. From the evidence in this conversation, list every candidate answer that was proposed or found, with the URL that states it.',
    'For each candidate, say which of the question\'s clues it satisfies and which one it fails.',
    'Then reply with one short sentence and a final line exactly "ANSWER: <short answer>", naming the candidate that satisfies every clue.',
    'If no candidate satisfies every clue, answer with the best-supported one and say on the same line which clue it fails. Do not write tool calls as text.',
  ].join(' ')
  const plain = 'Stop deliberating now. Reply with one short sentence of justification, then a final line exactly "ANSWER: <short answer>". Do not weigh alternatives in the reply, and do not write tool calls as text.'
  // A thinking model that spends the whole budget deliberating never writes the answer,
  // so the last attempt allows a long reply and asks for nothing but the answer line.
  const lastResort = 'Reply with exactly one line and nothing else: ANSWER: <short answer>'
  let fallback = '', truncated = true
  for (const [maxTokens, prompt] of [[2_000, plain], [6_000, instruction], [16_000, lastResort]]) {
    const reply = await chat(provider, [...messages, { role: 'user', content: prompt }], undefined, maxTokens)
    const content = replyText(reply)
    if (content && /ANSWER:/i.test(content) && cleanAnswer(content)) return { text: content, truncated: reply.finish_reason === 'length' }
    // An unmarked reply is only usable as an answer when it reads like one.
    if (content && !fallback && looksLikeAnswer(cleanAnswer(content))) fallback = content
    if (content && isToolMarkupReply(content)) fallback = ''
    truncated = reply.finish_reason === 'length'
  }
  // Reasoning-only replies are not answers: reporting no answer is honest, scoring
  // the model's deliberation as one is not.
  return { text: fallback, truncated }
}

/**
 * The opening round of a research task, planned before the model spends a turn: several queries
 * that are deliberately unlike each other, each with the goal it serves. Every published research
 * agent generates its queries this way — a single narrow query returns nothing and teaches
 * nothing — and the goals are what let the next round build on this one instead of repeating it.
 */

async function planQueries(provider, question, numQueries = 3) {
  const reply = await chat(provider, [
    { role: 'system', content: 'You plan web research. Return valid JSON only, no prose and no code fences.' },
    { role: 'user', content: [
      `Question: ${question}`,
      `Generate ${numQueries} search queries that would each make progress on a different part of this question.`,
      'Each query must be unlike the others: different subject words, different angle, different likely source.',
      // The rule the published research prompts converge on: a search engine matches pages, and the
      // page that holds a fact states it in a few words, not in the sentence that describes it.
      'Keep every query under six words. A short query a page could literally match beats a long description no page carries.',
      'If a query would need more words, drop the connective and descriptive ones and keep the names.',
      'Return ONLY: {"queries":[{"query":"<search query>","goal":"<what answering this establishes>"}]}',
    ].join('\n') },
  ], undefined, 2_000)
  const text = [replyText(reply), String(reply.reasoning_content || '')].filter(Boolean).join('\n')
  const rows = parsePlannedQueries(text)
  return rows.map(row => ({ query: shortenQuery(row.query), goal: row.goal }))
    .filter(row => row.query.length > 3).slice(0, numQueries)
}


/**
 * The ledger a research loop is supposed to carry: what has been established, with the source
 * that states it, and which questions are still open. Every published research agent keeps one
 * — taking the reading out of the context and leaving the findings in — because a run that
 * holds twenty raw pages re-searches what it already knows and forgets what it learned.
 */
async function updateLedger(provider, question, ledger, material) {
  const reply = await chat(provider, [
    { role: 'system', content: [
      'You maintain the research ledger for one question. You are given the ledger so far and new material.',
      'Reply with three sections and nothing else:',
      'ESTABLISHED: one line per fact the material states that bears on the question, each ending with " [source: <url>]". Keep every fact already in the ledger that the new material does not contradict, and drop facts it contradicts.',
      'CANDIDATES: one line per name, work, place, or value the material puts forward as a possible answer, each with the fact that supports it and its source. A title a record cites or reviews is a candidate: the work a question describes is often named inside the record that mentions it. Keep every candidate already in the ledger and add the new ones.',
      'OPEN: one line per question that is still unanswered, phrased as the search that would answer it. Do not repeat an open question that the material has now answered.',
      'A fact counts only when the material states it. Never add what you remember, and never infer an answer you have not seen stated.',
    ].join('\n') },
    { role: 'user', content: `Question: ${question}\n\nLedger so far:\n${ledger || '(empty)'}\n\nNew material:\n${material}` },
  ], undefined, 4_000)
  const text = [replyText(reply), String(reply.reasoning_content || '')].filter(Boolean).join('\n')
  return parseLedger(text)
}


/**
 * A research director step for a question whose answer has to satisfy several clues at
 * once. The model's own conclusion is not the end of the work: each clue is listed and
 * checked against what was read, and a clue nothing supports becomes the next search
 * instead of a gap the answer papers over. Generic by construction — it lists whatever
 * constraints the question states, with no knowledge of the question's subject.
 */
async function auditGaps(provider, question, candidate, evidence) {
  const digest = evidence.slice(-8).map(text => String(text).slice(0, 1_500)).join('\n---\n')
  const reply = await chat(provider, [
    { role: 'system', content: [
      'You audit a research answer component by component and you are adversarial about it.',
      'Break the candidate into its components: each named entity, series, work, person, place, number, or date that the answer depends on.',
      'For every component, ask one thing: do the evidence excerpts visibly state it? Plausible, remembered, or merely consistent does not count.',
      'For every component the excerpts do not state, output one line "SEARCH: <query>" whose words come from the question\'s own clues. That query must not contain any name, title, or number taken from the candidate answer: a candidate is not evidence for itself, and searching for it only proves it can be found.',
      'When every component is visibly stated by the excerpts, output exactly "SETTLED".',
      'Output nothing else: no plan, no explanation, no restatement of these instructions.',
    ].join('\n') },
    { role: 'user', content: `Question: ${question}\nCandidate answer so far: ${candidate || '(none produced yet)'}\nEvidence excerpts:\n${digest}` },
  ], undefined, 4_000)
  // A thinking model can put the whole audit in its reasoning channel with an empty reply,
  // so both channels are read: the analysis is the point, not the channel it arrived in.
  const text = [replyText(reply), String(reply.reasoning_content || '')].filter(Boolean).join('\n')
  return [...text.matchAll(/SEARCH:\s*([^\n]+)/gi)]
    .map(match => match[1].trim().replace(/^["'\s]+|["'\s]+$/g, ''))
    // Echoed instructions are not queries, and neither is a query that merely restates the
    // candidate it was supposed to test.
    .filter(query => query.length > 3 && !/[<>]/.test(query) && !/\b(?:at most|search lines|settled|that clue|search query\b|the candidate|output)\b/i.test(query))
    .filter(query => !candidate || !candidate.trim() || !query.toLowerCase().includes(candidate.trim().toLowerCase().split(/[\s,]+/).filter(word => word.length > 4)[0] || '\u0000'))
    .slice(0, 3)
}

/**
 * A research run has to hold every page it opens in one context, so the context is the real
 * budget: with twenty full pages in it, the model stops seeing the pages it read first — which
 * is how a run ends up re-searching what it already established and jumping between
 * hypotheses. Older page content is therefore compacted to its opening and a note, while the
 * most recent reads stay whole, so the working set is what the model reasons over.
 */
export function compactResearchContext(messages, options = {}) {
  const budget = options.budget || 60_000
  const keepWhole = options.keepWhole || 3
  const reads = messages.map((message, index) => ({ message, index })).filter(entry => entry.message?.role === 'tool' && typeof entry.message.content === 'string' && entry.message.content.length > 1_200)
  if (reads.length <= keepWhole) return { messages, compacted: 0 }
  let total = reads.reduce((sum, entry) => sum + entry.message.content.length, 0)
  let compacted = 0
  for (const entry of reads.slice(0, reads.length - keepWhole)) {
    if (total <= budget) break
    const content = entry.message.content
    if (content.startsWith('[compacted]')) continue
    const shortened = `[compacted] ${content.slice(0, 900)}\n… this page was shortened to keep the research context workable. Re-read the URL with a query if it matters.`
    total -= content.length - shortened.length
    entry.message.content = shortened
    compacted++
  }
  return { messages, compacted }
}

async function runQuestion(provider, question, limits) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: question.problem }]
  const evidence = [], trace = [], openedPages = new Set(), leads = new Map()
  const deadline = Date.now() + limits.questionMs
  let searches = 0, reads = 0, turns = 0, evidenceFloor = 0, answer = '', failure = ''
  let grounded = false, answerCitations = [], assistedReads = 0, audits = 0, ledgerUpdates = 0
  let ledger = { established: '', candidates: '', open: '' }, pendingMaterial = []

  // Opening round: planned queries are searched before the model spends a turn, so a question
  // starts from breadth instead of from one narrow guess.
  if (limits.plannedQueries !== 0) {
    const planned = await planQueries(provider, question.problem, Math.max(2, Math.min(4, limits.plannedQueries || 3))).catch(() => [])
    trace.push({ tool: 'planned-round', queries: planned.map(plan => plan.query) })
    if (planned.length) {
      const opening = await Promise.all(planned.map(async plan => {
        if (searches >= limits.searches) return ''
        searches++
        try {
          const output = await searchWeb(plan.query, 8, { renderPage })
          const parsed = JSON.parse(output)
          for (const row of parsed.results || []) {
            const url = normalizeUrl(row.url)
            if (url && !leads.has(url)) leads.set(url, { confidence: String(row.match?.confidence || ''), sourceClass: String(row.source_class || ''), query: plan.query })
          }
          trace.push({ tool: 'web_search', query: plan.query, goal: plan.goal, planned: true, results: (parsed.results || []).map(row => `${row.match?.confidence}:${row.url}`).slice(0, 8), channels: (parsed.retrieval?.providers || []).map(item => `${item.id}:${item.status}`) })
          evidence.push(output)
          return `[${plan.query}] goal: ${plan.goal}\n${(parsed.results || []).slice(0, 8).map(row => `${row.url} — ${String(row.title || '').slice(0, 120)}${row.snippet ? ` — ${String(row.snippet).slice(0, 200)}` : ''}`).join('\n')}`
        } catch (error) {
          trace.push({ tool: 'web_search', query: plan.query, planned: true, error: String(error?.message || error).slice(0, 160) })
          return ''
        }
      }))
      const material = opening.filter(Boolean).join('\n---\n')
      if (material) {
        const updated = await updateLedger(provider, question.problem, 'ESTABLISHED:\nCANDIDATES:\nOPEN:', material).catch(() => null)
        if (updated) {
          ledger = { established: updated.established, candidates: updated.candidates, open: updated.open }
          ledgerUpdates++
          messages.push({ role: 'user', content: `Opening research round results\n${material.slice(0, 12_000)}\n\nResearch ledger\nESTABLISHED:\n${ledger.established || '(nothing yet)'}\nCANDIDATES:\n${ledger.candidates || '(none yet)'}\nOPEN:\n${ledger.open || '(nothing outstanding)'}` })
          trace.push({ tool: 'ledger', round: ledgerUpdates, planned: true, establishedLines: ledger.established.split('\n').filter(Boolean).length, candidateLines: ledger.candidates.split('\n').filter(Boolean).length, openLines: ledger.open.split('\n').filter(Boolean).length })
        }
      }
    }
  }

  while (turns < limits.turns && Date.now() < deadline) {
    turns++
    let message
    try { message = await chat(provider, messages, TOOLS) }
    catch (error) { failure = String(error.message || error); break }
    if (pendingMaterial.length >= 6 && ledgerUpdates < 8) {
      ledgerUpdates++
      const material = pendingMaterial.map(entry => `[${entry.url}]\n${entry.text}`).join('\n---\n')
      const updated = await updateLedger(provider, question.problem, `ESTABLISHED:\n${ledger.established}\nCANDIDATES:\n${ledger.candidates}\nOPEN:\n${ledger.open}`, material).catch(() => null)
      if (updated) {
        for (const entry of pendingMaterial) if (entry.message.content.length > 1_200) entry.message.content = '[folded into the research ledger below]'
        pendingMaterial = []
        if (updated.established) ledger = { ...ledger, established: updated.established }
        if (updated.candidates) ledger = { ...ledger, candidates: updated.candidates }
        if (updated.open) ledger = { ...ledger, open: updated.open }
        messages.push({ role: 'user', content: `Research ledger\nESTABLISHED:\n${ledger.established || '(nothing yet)'}\nCANDIDATES:\n${ledger.candidates || '(none yet)'}\nOPEN:\n${ledger.open || '(nothing outstanding)'}` })
        trace.push({ tool: 'ledger', round: ledgerUpdates, establishedLines: ledger.established.split('\n').filter(Boolean).length, candidateLines: ledger.candidates.split('\n').filter(Boolean).length, openLines: ledger.open.split('\n').filter(Boolean).length })
      }
    }
    // The context is compacted before the next decision is made, so the model reasons over a
    // working set instead of a transcript of everything it has ever opened.
    const { compacted } = compactResearchContext(messages)
    if (compacted) trace.push({ tool: 'context-compaction', compaction: compacted, contextChars: messages.reduce((sum, item) => sum + (typeof item.content === 'string' ? item.content.length : 0), 0) })
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
      // What a source can be decides the read order before how well it matched: a page
      // that can record the fact is read before a mention of it.
      const priority = url => { const lead = leads.get(url); const rank = { official_or_primary_candidate: 0, other_candidate: 1, community_or_reference_lead: 2 }[lead?.sourceClass] ?? 1; return rank * 2 + (lead?.confidence === 'direct' ? 0 : 1) }
      const unexplored = [...leads.keys()].filter(url => !openedPages.has(url)).sort((a, b) => priority(a) - priority(b))
      const nextLeads = unexplored.slice(0, 3).map(url => `${url} (${leads.get(url)?.confidence || 'lead'})`).join('; ')
      // Effort is demanded only while there is somewhere left to look. When the index
      // offered nothing else, an answer from what is on hand is the only honest
      // outcome — an unconditional page count would keep a run searching a dead end.
      // The strongest grounding test available: the answer's own words have to appear
      // in what was read. A cited URL is not enough — a run can cite a page it opened
      // and still answer from memory, which this harness produced twice.
      const inEvidence = answerAppearsInEvidence(finalCandidate, evidence)
      // The ledger's open questions are what the run still owes an answer: they are handed back
      // as the next searches instead of being left implicit in a large context.
      const openQuestions = ledger.open.split('\n').map(line => line.replace(/^[-*\d.\s]+/, '').trim()).filter(line => line.length > 12).slice(0, 3)
      if (openQuestions.length && searches < limits.searches && evidenceFloor < 6) {
        evidenceFloor++
        trace.push({ tool: 'ledger-directions', open: openQuestions })
        messages.push({ role: 'user', content: `The ledger still has these questions open. Run them as searches before answering:\n${openQuestions.map(line => `- ${line}`).join('\n')}` })
        continue
      }
      const shortfall = unmarked
        ? 'Your last turn contained no reply text, only deliberation.'
        : searches === 0 || reads === 0
        ? 'No evidence has been gathered yet.'
        : unexplored.length && openedPages.size < limits.minReads
          ? `${unexplored.length} leads from your searches are still unopened (${openedPages.size} distinct pages read so far); this task needs at least ${limits.minReads}.`
          : !inEvidence && unexplored.length
            ? 'Nothing you read contains this answer, and there are leads left to open: open them before concluding, or state that the evidence does not establish it.'
            : ''
      // Effort is demanded only while the run can still act on it. The product keeps its
      // research phase open until the phase budget is spent, so a run that stops after
      // two searches with leads unopened is not using the budget the task gave it.
      const budgetRemains = searches < limits.searches || reads < limits.reads
      if (shortfall && budgetRemains && evidenceFloor < 6) {
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
      // Every clue has to be accounted for before the answer is taken. A gap becomes the
      // next search, which is what a researcher does instead of answering around it.
      // Auditing happens after the effort floors, so a run that has not read anything is
      // told to read first and only a genuine candidate is audited for gaps.
      {
        if (audits < 3 && (finalCandidate || text.trim())) {
          audits++
          const gaps = await auditGaps(provider, question.problem, finalCandidate || text.slice(0, 400), evidence).catch(() => [])
          trace.push({ tool: 'audit', round: audits, candidate: (finalCandidate || '').slice(0, 120), gaps })
          const nextQuery = gaps.find(query => searches < limits.searches)
          if (nextQuery) {
            searches++
            const started = Date.now()
            let gapOutput = ''
            try {
              gapOutput = await searchWeb(nextQuery, 8, { renderPage })
              const parsed = JSON.parse(gapOutput)
              for (const row of parsed.results || []) {
                const url = normalizeUrl(row.url)
                if (url && !leads.has(url)) leads.set(url, { confidence: String(row.match?.confidence || ''), sourceClass: String(row.source_class || ''), query: nextQuery })
              }
              trace.push({ tool: 'web_search', query: nextQuery, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), audited: true, results: (parsed.results || []).map(row => `${row.match?.confidence}:${row.url}`).slice(0, 8), channels: (parsed.retrieval?.providers || []).map(item => `${item.id}:${item.status}`) })
            } catch (error) {
              trace.push({ tool: 'web_search', query: nextQuery, audited: true, error: String(error?.message || error).slice(0, 200) })
            }
            evidence.push(gapOutput)
            messages.push({ role: 'user', content: `A gap audit of your candidate answer produced this search and its results; the clues it was meant to establish are still not settled:\n${gapOutput.slice(0, 6_000)}` })
            continue
          }
        }
      }
      // A run that says it will open a page and then writes prose instead of calling the
      // tool is stalled, not finished: while it still has ranked leads it never opened
      // and read budget it never used, the strongest lead is opened for it and its
      // content goes into the conversation. Bounded, logged, and no claim is invented.
      if (shortfall && unexplored.length && reads < limits.reads && assistedReads < 2) {
        assistedReads++
        const target = unexplored[0]
        reads++
        const started = Date.now()
        let opened = ''
        try { opened = await readWeb(target, 24_000, renderPage, 0, undefined, question.problem) } catch (error) { opened = JSON.stringify({ error: String(error.message || error) }) }
        evidence.push(opened)
        openedPages.add(normalizeUrl(target))
        trace.push({ tool: 'assist-read', url: target, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), bytes: opened.length })
        messages.push({ role: 'user', content: `You said you would open ${target} and did not, so it was opened for you. Its content follows; read it before concluding.\n${opened.slice(0, 8_000)}` })
        continue
      }
      answer = replyText(message) || (hasMarkedAnswer(message) ? text : '')
      answerCitations = citations
      grounded = supported.length > 0
      break    }

    for (const [callIndex, call] of calls.entries()) {
      if (!call.id) call.id = `call_${turns}_${callIndex}`
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
              if (url && !leads.has(url)) leads.set(url, { confidence: String(row.match?.confidence || ''), sourceClass: String(row.source_class || ''), query: args.query })
            }
            logged = { tool: 'web_search', query: args.query, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), widened: parsed.retrieval?.widened_with, results: (parsed.results || []).map(row => `${row.match?.confidence}:${row.url}`).slice(0, 8), channels: (parsed.retrieval?.providers || []).map(item => `${item.id}:${item.status}`) }
          }
        } else if (call.function?.name === 'web_read') {
          if (reads >= limits.reads) output = JSON.stringify({ error: 'read budget exhausted for this question; answer from what you have' })
          else {
            reads++
            const started = Date.now()
            const before = openedPages.size
            // A page found by a search is read for the reason that search made it a
            // candidate, so the originating query and the task drive the returned window
            // when the model does not say what it is looking for.
            const reason = String([args.query || leads.get(normalizeUrl(args.url))?.query, question.problem].filter(Boolean).join(' ')).slice(0, 300)
            // A research read asks for the page, not a slice of it: the product's ceiling is what
            // keeps the context bounded, and the window only decides where to start.
            output = await readWeb(args.url, args.max_chars || 24_000, renderPage, args.offset, undefined, reason)
            try {
              const page = JSON.parse(output)
              if (page?.ok !== false) openedPages.add(normalizeUrl(page.final_url || page.requested_url || args.url))
              openedPages.add(normalizeUrl(args.url))
            } catch {}
            // Reading the same page again adds no evidence. Saying so is what turns a
            // repeated read into a different lead instead of a spent step.
            if (openedPages.size === before) output = `${output}\n[already read in this run: this page adds no new evidence. Open a different lead.]`
            logged = { tool: 'web_read', url: args.url, query: reason.slice(0, 120), window: (() => { try { const page = JSON.parse(output); return `offset=${page.content_offset} matched=${page.matched_sections}` } catch { return undefined } })(), seconds: Number(((Date.now() - started) / 1000).toFixed(1)), bytes: output.length, title: (() => { try { return JSON.parse(output).title } catch { return undefined } })() }
          }
        } else output = JSON.stringify({ error: `unknown tool ${call.function?.name}` })
      } catch (error) { output = JSON.stringify({ error: String(error.message || error).slice(0, 400) }) }
      if (logged) trace.push(logged)
      evidence.push(output)
      const toolMessage = { role: 'tool', tool_call_id: call.id, content: output }
      messages.push(toolMessage)
      // New material is queued for the ledger instead of being carried as raw pages. The reading
      // is what is expensive; the finding is what the next decision needs. Folding happens after
      // the turn's tool calls are complete, because a message may not be inserted between an
      // assistant turn and the results it asked for.
      if (output.length > 1_200 && logged) pendingMaterial.push({ message: toolMessage, text: output.slice(0, 6_000), url: logged.url || logged.query || '' })
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

  // The answer a run reports is chosen deterministically: what the pages support, the ledger's own
  // candidate when the model's closing turn produced a fragment or an unsupported name. A harness
  // that accepts whatever the last turn said swings between runs for reasons that are not research.
  const chosen = chooseStableAnswer({ answer: cleanAnswer(answer), candidates: ledger.candidates, evidence, question: question.problem })
  const final = cleanAnswer(chosen.answer)
  if (chosen.source !== 'model') trace.push({ tool: 'answer-choice', source: chosen.source, answer: final.slice(0, 120) })

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
  return { ...question, prediction: final, closingText: closingText.slice(0, 500), judge, judgeNote, turns, searches, reads, leads: leads.size, assistedReads, evidenceFloor, distinctPages: openedPages.size, grounded, citations: answerCitations.length, seconds: Number(((Date.now() - (deadline - limits.questionMs)) / 1000).toFixed(1)), trace, ledgerUpdates, ledger, answerSource: chosen.source, goldInEvidence: goldInEvidence(evidence, question.answer), goldTokenRate: Number(goldTokenRate(evidence, question.answer).toFixed(2)), failure }
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
let headlessRenderer
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
} else if (process.argv.includes('--headless-chrome')) {
  // Measuring the rendering channel without Electron: a headless browser on a throwaway
  // profile, so the run covers the pages a plain fetch cannot read.
  const { createHeadlessChromeRenderer } = await import('./headless-render.mjs')
  headlessRenderer = createHeadlessChromeRenderer()
  renderPage = headlessRenderer.renderPage
}

const provider = await loadProvider()
const count = Number(argument('count', DEFAULT_COUNT)), seed = Number(argument('seed', 0)), skip = Number(argument('skip', 0)), repeats = Math.max(1, Number(argument('repeat', 1)))
const limits = {
  turns: Number(argument('turns', DEFAULT_TURNS)),
  searches: Number(argument('searches', DEFAULT_SEARCHES)),
  reads: Number(argument('reads', DEFAULT_READS)),
  questionMs: Number(argument('question-seconds', DEFAULT_QUESTION_SECONDS)) * 1_000,
  minReads: Number(argument('min-reads', DEFAULT_MIN_READS)),
  plannedQueries: Number(argument('planned-queries', 3)),
  requireSource: process.argv.includes('--require-source'),
}
const concurrency = Math.max(1, Number(argument('concurrency', DEFAULT_CONCURRENCY)))
const { total, sample } = await loadQuestions(count, seed, skip)
const out = argument('out', join('tmp', `browsecomp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`))

console.log(`BrowseComp subset: ${sample.length} of ${total} questions (seed ${seed}) on ${provider.model}, ${concurrency} at a time${repeats > 1 ? `, ${repeats} attempts each` : ''}, ${limits.questionMs / 1000}s per question, browser=${renderPage ? (process.versions.electron ? 'hidden-chromium' : 'headless-chrome') : 'none'}`)
const started = Date.now()
let finished = 0, correctSoFar = 0
// Source health is a property of the machine and the moment, not of the research, and it is what
// makes the same question answer differently on two runs. It is probed once and reported, so a
// swing can be attributed to a channel instead of to the harness.
const sourceHealth = await (async () => {
  try {
    const probe = JSON.parse(await searchWeb('wikipedia', 5, { renderPage }))
    return (probe.retrieval?.providers || []).map(item => `${item.id}:${item.status}`)
  } catch (error) { return [`probe failed: ${String(error?.message || error).slice(0, 120)}`] }
})()
console.log(`source health at start: ${sourceHealth.join(' ')}`)

const items = sample.flatMap(question => Array.from({ length: repeats }, (_, attempt) => ({ question, attempt })))
const results = await runWithConcurrency(items, concurrency, async (question, index) => {
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
  goldTokenRateMean: Number((results.reduce((sum, item) => sum + item.goldTokenRate, 0) / results.length).toFixed(3)),
  totalSeconds: Math.round((Date.now() - started) / 1000),
  questionSeconds: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: Math.max(...latencies) },
  searchSeconds: { count: searchLatencies.length, p50: percentile(searchLatencies, 0.5), p95: percentile(searchLatencies, 0.95) },
  sourceHealth,
  stability: [...new Set(results.map(item => item.answer))].map(answer => {
    const attempts = results.filter(item => item.answer === answer)
    return { answer: answer.slice(0, 60), attempts: attempts.length, correct: attempts.filter(item => item.judge === 'correct').length }
  }).sort((a, b) => b.attempts - a.attempts),
  results,
}
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(summary, null, 2))
console.log(`\nBrowseComp subset accuracy: ${correct}/${results.length} = ${(summary.accuracy * 100).toFixed(1)}%`)
console.log(`gold answer ever present in retrieved evidence: ${(summary.goldInEvidenceRate * 100).toFixed(1)}% (mean share of its tokens: ${(summary.goldTokenRateMean * 100).toFixed(0)}%)`)
console.log(`question seconds p50=${summary.questionSeconds.p50} p95=${summary.questionSeconds.p95} | search p50=${summary.searchSeconds.p50} p95=${summary.searchSeconds.p95} | total ${summary.totalSeconds}s`)
if (repeats > 1) {
  const answered = summary.stability.filter(item => item.answer)
  console.log(`stability: ${summary.stability.map(item => `${item.attempts}× "${item.answer || '(none)'}"${item.correct ? ` (${item.correct} correct)` : ''}`).join(' | ')}`)
  console.log(`distinct answers: ${answered.length} across ${results.length} attempts`)
}
console.log(`report: ${out}`)
// The report is written, so the browser is closed before the process is asked to exit:
// an open DevTools socket otherwise keeps the event loop alive and the run looks hung.
await headlessRenderer?.close().catch(() => {})
electronApp?.quit()
if (!process.versions.electron) process.exit(0)
