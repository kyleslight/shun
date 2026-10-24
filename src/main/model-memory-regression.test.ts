import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const execute = promisify(execFile)
const script = fileURLToPath(new URL('../../scripts/model-memory-regression.mjs', import.meta.url))

async function fixture(handler: (body: any, index: number) => { status: number; content: string; promptTokens?: number }) {
  const requests: any[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(body)
    const result = handler(body, requests.length)
    response.writeHead(result.status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(result.status === 200 ? { choices: [{ message: { content: result.content } }], usage: { prompt_tokens: result.promptTokens ?? 100001 } } : { error: result.content }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('missing fixture endpoint')
  const directory = await mkdtemp(join(tmpdir(), 'shun-model-memory-'))
  return {
    requests, report: join(directory, 'report.json'), endpoint: `http://127.0.0.1:${address.port}/v1`,
    async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }) },
  }
}

test('memory regression stops after a failed pair without replaying it or recording response secrets', async () => {
  const server = await fixture((_body, index) => ({ status: index === 2 ? 503 : 200, content: index === 2 ? 'private-response-marker' : 'OK' }))
  try {
    await assert.rejects(execute(process.execPath, [script, '--endpoint', server.endpoint, '--model', 'fixture', '--report', server.report, '--steps', '2', '--observation-chars', '100', '--minimum-tokens', '0', '--pairs', '3', '--skip-images'], { timeout: 15000 }))
    const raw = await readFile(server.report, 'utf8'), report = JSON.parse(raw)
    assert.equal(server.requests.length, 3)
    assert.equal(report.passed, false)
    assert.equal(report.cases.length, 3)
    assert.equal(report.cases.filter((item: any) => !item.passed).length, 1)
    assert.equal(raw.includes('private-response-marker'), false)
  } finally { await server.close() }
})

test('memory regression cannot qualify a short response as a long-context sample', async () => {
  const server = await fixture(() => ({ status: 200, content: 'OK', promptTokens: 64 }))
  try {
    await assert.rejects(execute(process.execPath, [script, '--endpoint', server.endpoint, '--model', 'fixture', '--report', server.report, '--steps', '2', '--observation-chars', '100', '--minimum-tokens', '100000', '--pairs', '1', '--skip-images'], { timeout: 15000 }))
    const report = JSON.parse(await readFile(server.report, 'utf8'))
    assert.equal(server.requests.length, 1)
    assert.equal(report.passed, false)
    assert.equal(report.cases[0].failure, 'Fixture below required token count')
  } finally { await server.close() }
})

test('memory regression accumulates real image dimensions and preserves a 31-image cold-prefix case', async () => {
  let checkedImage = false
  const imageCounts: number[] = []
  const server = await fixture(body => {
    const images = body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((part: any) => part.type === 'image_url') : [])
    if (images.length) {
      imageCounts.push(images.length)
      if (!checkedImage) {
        const bytes = Buffer.from(images[0].image_url.url.split(',')[1], 'base64')
        assert.equal(bytes.readUInt32BE(16), 2600)
        assert.equal(bytes.readUInt32BE(20), 1800)
        const data: Buffer[] = []
        for (let offset = 8; offset < bytes.length;) {
          const length = bytes.readUInt32BE(offset)
          if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length))
          offset += length + 12
        }
        const pixels = inflateSync(Buffer.concat(data))
        assert.equal(pixels.length, 1800 * (2600 * 3 + 1))
        assert.deepEqual([...pixels.subarray(0, 4)], [0, 255, 0, 0])
        checkedImage = true
      }
    }
    return { status: 200, content: images.length ? 'red' : 'OK' }
  })
  try {
    await execute(process.execPath, [script, '--endpoint', server.endpoint, '--model', 'fixture', '--report', server.report, '--steps', '2', '--observation-chars', '100', '--minimum-tokens', '100000', '--pairs', '1'], { timeout: 20000 })
    const report = JSON.parse(await readFile(server.report, 'utf8'))
    assert.equal(report.passed, true)
    assert.equal(server.requests.length, 9)
    assert.deepEqual(imageCounts, [1, 3, 7, 15, 31, 31])
    assert.equal(report.cases.at(-1).label, 'cold_rich_dialogue_with_31_images')
  } finally { await server.close() }
})
