import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runPluginWorker } from './plugin-worker.ts'

test('package worker receives structured input and returns bounded structured output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-worker-'))
  await mkdir(join(root, 'worker'))
  const entry = join(root, 'worker', 'index.mjs')
  await writeFile(entry, `let text=''; for await (const chunk of process.stdin) text += chunk; const input=JSON.parse(text); process.stderr.write('compiled'); process.stdout.write(JSON.stringify({sum: input.a + input.b, cwd: process.cwd()}));`)
  const result = await runPluginWorker({ entry, workspace: root, input: { a: 2, b: 3 }, timeoutMs: 2_000 })
  assert.equal((result.value as any).sum, 5)
  assert.match((result.value as any).cwd, new RegExp(`${root.split('/').pop()}$`))
  assert.equal(result.diagnostics, 'compiled')
})

test('package worker timeout terminates the isolated process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-worker-timeout-')), entry = join(root, 'worker.mjs')
  await writeFile(entry, `process.stdin.resume(); setInterval(() => {}, 1000)`)
  await assert.rejects(runPluginWorker({ entry, workspace: root, input: {}, timeoutMs: 100 }), /timed out/)
})

test('a newer worker invocation replaces the previous invocation in the same task slot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-worker-slot-')), entry = join(root, 'worker.mjs')
  await writeFile(entry, `let text=''; for await (const chunk of process.stdin) text += chunk; const input=JSON.parse(text); setTimeout(() => process.stdout.write(JSON.stringify(input)), input.delay)`)
  const first = runPluginWorker({ entry, workspace: root, input: { value: 'old', delay: 2_000 }, timeoutMs: 5_000, slotKey: 'task/plugin/worker' })
  await new Promise(resolve => setTimeout(resolve, 50))
  const second = runPluginWorker({ entry, workspace: root, input: { value: 'new', delay: 0 }, timeoutMs: 5_000, slotKey: 'task/plugin/worker' })
  await assert.rejects(first, /exited with code/)
  assert.deepEqual((await second).value, { value: 'new', delay: 0 })
})
