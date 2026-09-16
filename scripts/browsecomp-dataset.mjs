import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * The BrowseComp test set, shared by the tools that measure against it: the agent
 * benchmark and the retrieval probe. The official set is XOR-encrypted with a
 * per-row canary so it cannot be scraped, and is decrypted exactly as
 * openai/simple-evals does.
 */
export const DATASET_URL = 'https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv'

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
