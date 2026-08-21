import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(fileURLToPath(import.meta.url))

test('prompt wording cannot enter capability or hidden execution-policy control flow', async () => {
  const [index, runtime, capabilities] = await Promise.all([
    readFile(join(root, 'index.ts'), 'utf8'),
    readFile(join(root, 'pi-runtime.ts'), 'utf8'),
    readFile(join(root, 'capabilities.ts'), 'utf8'),
  ])

  const indexTextUses = index.split('\n').filter(line => line.includes('req.text'))
  assert.deepEqual(indexTextUses.map(line => line.trim()), [
    "void recordTaskEvent(req.taskId, { type: 'request', runId: req.id, text: req.text })",
  ])
  const runtimeTextUses = runtime.split('\n').filter(line => line.includes('req.text'))
  assert.deepEqual(runtimeTextUses.map(line => line.trim()), ['await session.prompt(req.text)'])
  assert.match(capabilities, /activeToolNames\(workspace: string, productToolNames: string\[\]\)/)
  assert.doesNotMatch(capabilities, /\b(?:req|request)\./)
  assert.doesNotMatch(`${index}\n${runtime}`, /selectKernelRoute|workspaceIntent|researchIntent|requestsNoVerification/)
  assert.doesNotMatch(index, /outcomePolicy\s*:/)
  assert.match(index, /toolNeedsApproval\(req\.settings\.permission, name\)/)
  assert.doesNotMatch(index, /commandIsDestructive|commandUsesNetworkClient|localNetworkCommandAllowed/)
})
