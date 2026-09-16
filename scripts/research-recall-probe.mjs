// Measure how much of the answer the retrieval layer can reach, with one query
// versus a spread of mechanical reformulations. The model does not participate, so
// this isolates recall — the ceiling every agent shares — from answering behaviour.
//
//   node --experimental-strip-types scripts/research-recall-probe.mjs --count 12 --reads 2
//
// Recall is measured as "the answer string appears somewhere in what came back",
// which is the strongest claim retrieval can make on its own.
import { searchWeb, readWeb } from '../src/main/web.ts'
import { goldInEvidence, loadQuestions } from './browsecomp-dataset.mjs'
import { queryVariants } from './query-variants.mjs'

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

async function gather(queries, readsPerQuery) {
  const evidence = [], sources = []
  let searchesWithResults = 0
  for (const query of queries) {
    let output = ''
    try { output = await searchWeb(query, 8) } catch (error) { evidence.push(String(error?.message || error)); continue }
    evidence.push(output)
    let rows = []
    try { rows = JSON.parse(output).results || [] } catch {}
    if (rows.length) searchesWithResults++
    for (const row of rows.slice(0, readsPerQuery)) {
      try {
        const page = await readWeb(row.url, 4_000, undefined, 0, undefined, query)
        evidence.push(page)
        sources.push(row.url)
      } catch (error) { evidence.push(String(error?.message || error)) }
    }
  }
  return { evidence, sources, searchesWithResults }
}

const provider = { questions: Number(argument('count', 12)), reads: Number(argument('reads', 2)), seed: Number(argument('seed', 0)), skip: Number(argument('skip', 0)) }
const { sample } = await loadQuestions(provider.questions, provider.seed, provider.skip)
console.log(`Recall probe: ${sample.length} questions, ${provider.reads} page reads per query, one query versus ${queryVariants(sample[0]?.problem || '').length} reformulations`)

const rows = []
for (const [index, question] of sample.entries()) {
  const variants = queryVariants(question.problem)
  const single = await gather([question.problem], provider.reads)
  const diverse = await gather(variants, provider.reads)
  const row = {
    question: question.problem.slice(0, 120),
    answer: question.answer,
    variants: variants.length,
    singleRecall: goldInEvidence(single.evidence, question.answer),
    diverseRecall: goldInEvidence(diverse.evidence, question.answer),
    singleHits: single.searchesWithResults,
    diverseHits: diverse.searchesWithResults,
  }
  rows.push(row)
  console.log(`[${index + 1}/${sample.length}] single=${row.singleRecall ? 'HIT ' : 'miss'} diverse=${row.diverseRecall ? 'HIT ' : 'miss'} searchesWithResults=${single.searchesWithResults}/${variants.length} | ${question.answer.slice(0, 40)}`)
}

const hit = key => rows.filter(row => row[key]).length
const summary = {
  questions: rows.length,
  singleRecall: Number((hit('singleRecall') / rows.length).toFixed(3)),
  diverseRecall: Number((hit('diverseRecall') / rows.length).toFixed(3)),
  gainedByDiversity: rows.filter(row => !row.singleRecall && row.diverseRecall).length,
  lostByDiversity: rows.filter(row => row.singleRecall && !row.diverseRecall).length,
  rows,
}
console.log(`\nrecall@evidence  single ${(summary.singleRecall * 100).toFixed(0)}%  →  diverse ${(summary.diverseRecall * 100).toFixed(0)}%`)
console.log(`gained ${summary.gainedByDiversity}, lost ${summary.lostByDiversity} of ${rows.length}`)
const { writeFile, mkdir } = await import('node:fs/promises')
await mkdir('tmp', { recursive: true })
await writeFile(argument('out', 'tmp/recall-probe.json'), JSON.stringify(summary, null, 2))
console.log(`report: ${argument('out', 'tmp/recall-probe.json')}`)
