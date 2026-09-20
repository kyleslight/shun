/**
 * Decision route check: proves each configured decision service actually answers.
 *
 * Acceleration can be routed to more than one service, and they only share a
 * protocol, not a wire address. This runs one real decision through the shipping
 * client for every route that has a credential, reporting the resolved endpoint,
 * the model, the answers, and the latency, so "Ready" in Settings is something
 * that was observed rather than assumed.
 *
 *   node --experimental-strip-types scripts/decision-route-check.mjs [--route typesafe]
 *
 * Credentials come from the environment first, then from the local credential
 * store, so a key that is already stored does not have to be exported again.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildActionCandidates, buildBrowserQuestions, buildJevState, decideBrowserFastStep, readVerdict } from '../src/main/browser-fast.ts'
import { OpenRouterJevClient, resolveComputerUseAcceleration } from '../src/main/jev-client.ts'
import { decisionRoutes } from '../src/shared.ts'

const run = promisify(execFile)
const only = process.argv.includes('--route') ? process.argv[process.argv.indexOf('--route') + 1] : undefined

const CREDENTIAL_SOURCES = {
  typesafe: { env: ['TYPESAFE_API_KEY', 'TYPESAFE_KEY'], store: 'typesafe', field: 'TYPESAFE_API_KEY' },
  vercel: { env: ['VERCEL_AI_GATEWAY_API_KEY', 'AI_GATEWAY_API_KEY', 'VERCEL_TOKEN'], store: 'vercel', field: 'AI_GATEWAY_API_KEY' },
  openrouter: { env: ['OPENROUTER_API_KEY'], store: 'openrouter', field: 'OPENROUTER_API_KEY' },
}

async function storedCredential(service, field) {
  try {
    const { stdout } = await run('python3', [`${process.env.HOME}/.shun/skills/credential-provisioning/scripts/keyctl.py`, 'get', service, field, '--raw'])
    return stdout.trim()
  } catch { return '' }
}

async function credentialFor(route) {
  const source = CREDENTIAL_SOURCES[route.id]
  for (const name of source.env) {
    const value = String(process.env[name] || '').trim()
    if (value) return { apiKey: value, from: name }
  }
  const stored = await storedCredential(source.store, source.field)
  return stored ? { apiKey: stored, from: `credential store: ${source.store}.${source.field}` } : undefined
}

// One ordinary browser state, so the check exercises the same questions the
// product asks rather than a toy prompt.
const snapshot = {
  tab: { id: 1, url: 'https://github.com/kyleslight/shun', title: 'kyleslight/shun' },
  readyState: 'complete',
  text: 'kyleslight/shun Public. Code Issues Pull requests Actions Settings.',
  nodes: [
    { ref: '7', role: 'heading', name: 'kyleslight/shun' },
    { ref: '11', role: 'link', name: 'Code' },
    { ref: '18', role: 'link', name: 'Issues' },
    { ref: '24', role: 'link', name: 'Settings' },
  ],
}
const goal = 'Open the repository Settings page.'
const candidates = buildActionCandidates(snapshot, goal)
const state = buildJevState({ goal, snapshot, candidates, history: [] })
const questions = buildBrowserQuestions(candidates)

const routes = Object.values(decisionRoutes).filter(route => !only || route.id === only)
let ready = 0
let missing = 0
let failed = 0

for (const route of routes) {
  const credential = await credentialFor(route)
  if (!credential) {
    missing += 1
    console.log(`SKIP ${route.id.padEnd(11)} ${route.label} — no credential (set ${CREDENTIAL_SOURCES[route.id].env[0]})`)
    continue
  }
  // Resolve exactly the way the product does, through the configured settings.
  const resolved = resolveComputerUseAcceleration({
    providers: [{ id: `${route.id}-provider`, name: route.label, kind: 'cloud', api: 'openai-completions', endpoint: route.endpoint, apiKey: credential.apiKey, contextWindow: 32_768 }],
    computerUseAcceleration: { provider: route.id },
  })
  if (!resolved) {
    failed += 1
    console.log(`FAIL ${route.id.padEnd(11)} ${route.label} — configuration did not resolve`)
    continue
  }
  const client = new OpenRouterJevClient({ apiKey: resolved.apiKey, endpoint: resolved.endpoint, timeoutMs: 20_000 })
  const started = Date.now()
  try {
    const response = await client.decide({ model: resolved.model, state, questions })
    const elapsed = Date.now() - started
    const verdict = readVerdict(response.answers)
    const decision = verdict ? decideBrowserFastStep(verdict, candidates, resolved) : undefined
    const ok = decision?.kind === 'act' && decision.candidate.id === 'click:24'
    ok ? ready += 1 : failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'} ${route.id.padEnd(11)} ${route.label.padEnd(20)} ${elapsed}ms  model=${resolved.model}`)
    console.log(`     endpoint ${resolved.endpoint}   credential from ${credential.from}`)
    console.log(`     answers  ${JSON.stringify(response.answers)}`)
    console.log(`     decision ${decision?.kind === 'act' ? `act ${decision.candidate.id} (p=${decision.probability.toFixed(2)})` : decision ? JSON.stringify(decision) : 'unreadable'}`)
    if (!ok) console.log(`     expected act click:24 from the offered candidates`)
  } catch (error) {
    failed += 1
    console.log(`FAIL ${route.id.padEnd(11)} ${route.label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`\n${ready} ready, ${missing} without a credential, ${failed} failing`)
if (failed) process.exitCode = 1
