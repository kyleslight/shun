// A real HTTP transport comparison with identical questions and source responses.
// This measures scheduling, not internet relevance or model reasoning quality.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { FreeSearchCoordinator } from '../src/main/web-search-coordinator.ts'

let active = 0
let peak = 0
const arrivals = []
const server = createServer((request, response) => {
  peak = Math.max(peak, ++active)
  arrivals.push(performance.now())
  setTimeout(() => {
    active--
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify([{ url: `https://example.test/${request.url.slice(1)}`, title: request.url.slice(1) }]))
  }, 150)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

async function measure(maxParallel) {
  peak = 0
  arrivals.length = 0
  const coordinator = new FreeSearchCoordinator({ maxParallel: 3, minIntervalMs: 20 })
  const source = {
    id: 'http-fixture', tier: 0, maxParallel,
    search: async query => (await fetch(`http://127.0.0.1:${port}/${query}`)).json(),
  }
  const start = performance.now()
  const responses = await Promise.all(['alpha', 'beta', 'gamma'].map(query => coordinator.search(query, 5, [source], rows => rows.length > 0)))
  return {
    milliseconds: Math.round(performance.now() - start),
    peakRequests: peak,
    startOffsetsMs: arrivals.map(at => Math.round(at - start)),
    urls: responses.flatMap(response => response.results.map(row => row.url)).sort(),
  }
}

try {
  const serial = await measure(1)
  const concurrent = await measure(3)
  assert.deepEqual(concurrent.urls, serial.urls)
  assert.equal(serial.peakRequests, 1)
  assert.equal(concurrent.peakRequests, 3)
  console.log(JSON.stringify({ scope: 'controlled HTTP scheduling; identical responses', serial, concurrent }, null, 2))
} finally {
  await new Promise(resolve => server.close(resolve))
}
