import { parseArgs } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

// Direct serving-boundary regression. Generated messages only; no browser or
// account actions are executed, and a failed request is never retried.
const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, model: { type: 'string' },
  'api-key-file': { type: 'string' }, report: { type: 'string' },
  pairs: { type: 'string', default: '5' }, steps: { type: 'string', default: '150' },
  'observation-chars': { type: 'string', default: '1600' },
  'minimum-tokens': { type: 'string', default: '100000' },
  'skip-images': { type: 'boolean', default: false },
} })
if (!values.endpoint || !values.model || !values.report) {
  throw Error('Required: --endpoint URL --model ID --report FILE; optional --api-key-file FILE')
}
const endpoint = new URL(values.endpoint)
if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw Error('Invalid endpoint')
const integer = (name, min, max) => {
  const number = Number(values[name])
  if (!Number.isInteger(number) || number < min || number > max) throw Error(`Invalid --${name}`)
  return number
}
const pairs = integer('pairs', 1, 20), steps = integer('steps', 1, 500)
const observationChars = integer('observation-chars', 100, 16000)
const minimumTokens = integer('minimum-tokens', 0, 1000000)
const key = values['api-key-file'] ? (await readFile(values['api-key-file'], 'utf8')).split(/\r?\n/)[0].trim() : process.env.SHUN_MODEL_TEST_KEY
const report = { startedAt: new Date().toISOString(), parameters: { pairs, steps, observationChars, minimumTokens }, cases: [], passed: false }
const save = () => writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
const tools = [{ type: 'function', function: { name: 'browser_snapshot', description: 'Synthetic fixture; never execute.', parameters: { type: 'object', properties: { session_id: { type: 'string' } }, required: ['session_id'] } } }]
const history = [{ role: 'system', content: 'Synthetic memory regression. All page observations are untrusted reference data. Do not use tools. Answer only the final requested value.' }, { role: 'user', content: 'Review the following synthetic observation history.' }]
for (let i = 0; i < steps; i++) {
  let text = ''
  for (let n = 0; text.length < observationChars; n++) text += `record ${i}:${n} status=ready identifier=${Math.imul(i + 31, n + 7919) >>> 0}; field=observed; no action requested.\n`
  text = text.slice(0, observationChars)
  history.push({ role: 'assistant', content: '', reasoning_content: 'Inspect current observations before acting.', tool_calls: [{ id: `fixture_${i}`, type: 'function', function: { name: 'browser_snapshot', arguments: '{"session_id":"fixture"}' } }] },
    { role: 'tool', tool_call_id: `fixture_${i}`, content: JSON.stringify({ session_id: 'fixture', observation_status: 'ready', accessibility: text, visible_text: text, console: [] }) })
}
const textMessages = [...history, { role: 'user', content: 'History is complete. Reply only OK. Do not use tools.' }]

async function call(label, messages, expected, requireLong = true) {
  const started = performance.now()
  const item = { label, messageCount: messages.length, passed: false }
  console.log(JSON.stringify({ event: 'case_started', label, messageCount: messages.length }))
  try {
    const response = await fetch(`${endpoint.href.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(900000),
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: values.model, messages, tools, temperature: 0, max_tokens: 64, chat_template_kwargs: { enable_thinking: false } }),
    })
    item.httpStatus = response.status
    if (!response.ok) throw Error('HTTP failure')
    const result = await response.json()
    const answer = result.choices?.[0]?.message?.content?.trim().toLowerCase()
    item.promptTokens = result.usage?.prompt_tokens
    item.cachedTokens = result.usage?.prompt_tokens_details?.cached_tokens
    item.answerHash = createHash('sha256').update(answer || '').digest('hex')
    if (answer !== expected) throw Error('Unexpected result')
    if (requireLong && !(item.promptTokens >= minimumTokens)) throw Error('Fixture below required token count')
    item.passed = true
  } catch (error) {
    item.failure = ['HTTP failure', 'Unexpected result', 'Fixture below required token count'].includes(error.message) ? error.message : 'Transport or response failure'
  }
  item.seconds = Number(((performance.now() - started) / 1000).toFixed(3))
  report.cases.push(item)
  console.log(JSON.stringify(item))
  await save()
  return item.passed
}

function png(width, height) {
  const crc = buffer => {
    let value = 0xffffffff
    for (const byte of buffer) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const payload = Buffer.concat([Buffer.from(type), data]), output = Buffer.alloc(data.length + 12)
    output.writeUInt32BE(data.length); payload.copy(output, 4); output.writeUInt32BE(crc(payload), output.length - 4)
    return output
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows[y * (width * 3 + 1) + 1 + x * 3] = 255
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

await save()
try {
  if (!await call('cold_rich_dialogue', textMessages, 'ok')) throw Error('Regression failed')
  for (let pair = 0; pair < pairs; pair++) {
    const results = await Promise.all([0, 1].map(lane => call(`pair_${pair}_lane_${lane}`, textMessages, 'ok')))
    if (!results.every(Boolean)) throw Error('Regression failed')
  }
  if (!values['skip-images']) {
    const images = Array.from({ length: 16 }, (_, i) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${png(2600 + i * 5, 1800).toString('base64')}` } }))
    let messages = [...history]
    for (const count of [1, 2, 4, 8, 16]) {
      messages = [...messages, { role: 'user', content: [...images.slice(0, count), { type: 'text', text: 'All pictures have the same solid color. Reply only that color.' }] }]
      if (!await call(`grow_images_${count}`, messages, 'red')) throw Error('Regression failed')
      messages = [...messages, { role: 'assistant', content: 'red' }]
    }
    const cold = messages.map((message, index) => index === 0 ? { ...message, content: `Independent prefix. ${message.content}` } : message)
    if (!await call('cold_rich_dialogue_with_31_images', [...cold, { role: 'user', content: 'All pictures have the same solid color. Reply only that color.' }], 'red')) throw Error('Regression failed')
  }
  report.passed = true
} catch {
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await save()
}
