import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { agentRuntimeHome, migrateLegacyAgentRuntime } from './runtime-home.ts'

test('agent runtime uses one cross-platform home-rooted Shun directory', () => {
  assert.deepEqual(agentRuntimeHome('/Users/example'), {
    root: '/Users/example/.shun',
    agentDir: '/Users/example/.shun',
    sessionDir: '/Users/example/.shun/sessions',
    standaloneDir: '/Users/example/.shun/standalone',
  })
  assert.equal(agentRuntimeHome('C:\\Users\\example', 'D:\\shun-test').root.endsWith('shun-test'), true)
})

test('legacy runtime migration merges without overwriting new-home files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-runtime-home-'))
  const legacy = join(root, 'legacy')
  const destination = agentRuntimeHome(root)
  await mkdir(join(legacy, 'agent', 'skills', 'old-skill'), { recursive: true })
  await mkdir(join(legacy, 'sessions'), { recursive: true })
  await mkdir(join(destination.root, 'skills', 'existing-skill'), { recursive: true })
  await writeFile(join(legacy, 'agent', 'skills', 'old-skill', 'SKILL.md'), 'old')
  await writeFile(join(legacy, 'agent', 'settings.json'), 'legacy settings')
  await writeFile(join(legacy, 'sessions', 'task.jsonl'), 'session')
  await writeFile(join(destination.root, 'settings.json'), 'new settings')

  const conflicts = await migrateLegacyAgentRuntime(legacy, destination)

  assert.deepEqual(conflicts, ['settings.json'])
  assert.equal(await readFile(join(destination.root, 'settings.json'), 'utf8'), 'new settings')
  assert.equal(await readFile(join(destination.root, 'skills', 'old-skill', 'SKILL.md'), 'utf8'), 'old')
  assert.equal(await readFile(join(destination.sessionDir, 'task.jsonl'), 'utf8'), 'session')
  assert.equal(await readFile(join(legacy, 'agent', 'settings.json'), 'utf8'), 'legacy settings')
})
