import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { parsePorcelainV2, repositoryFullDiff, repositorySnapshot } from './repository.ts'

const execFile = promisify(execFileCallback)

test('porcelain v2 parser keeps branch and working tree dimensions separate', () => {
  const raw = [
    '# branch.oid abcdef123456', '# branch.head feature', '# branch.upstream origin/feature', '# branch.ab +2 -3',
    '1 M. N... 100644 100644 100644 a b staged.ts',
    '1 .M N... 100644 100644 100644 a b working tree.ts',
    '? new.ts', '',
  ].join('\0')
  const value = parsePorcelainV2('/repo', raw)
  assert.equal(value.head, 'feature')
  assert.deepEqual([value.ahead, value.behind], [2, 3])
  assert.deepEqual(value.files.map(file => [file.path, file.staged, file.unstaged, file.untracked]), [
    ['staged.ts', true, false, false],
    ['working tree.ts', false, true, false],
    ['new.ts', false, false, true],
  ])
})

test('repository snapshot and full diff include staged, unstaged, and untracked files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-repository-'))
  await execFile('git', ['init'], { cwd: root })
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFile('git', ['config', 'user.name', 'Test'], { cwd: root })
  await writeFile(join(root, 'staged.txt'), 'before\n')
  await writeFile(join(root, 'working.txt'), 'before\n')
  await execFile('git', ['add', '.'], { cwd: root })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: root })
  await writeFile(join(root, 'staged.txt'), 'after staged\n')
  await execFile('git', ['add', 'staged.txt'], { cwd: root })
  await writeFile(join(root, 'working.txt'), 'after working\n')
  await writeFile(join(root, 'new.txt'), 'new\n')
  const snapshot = await repositorySnapshot(root)
  assert.ok(snapshot)
  assert.equal(snapshot.files.find(file => file.path === 'staged.txt')?.staged, true)
  assert.equal(snapshot.files.find(file => file.path === 'working.txt')?.unstaged, true)
  assert.equal(snapshot.files.find(file => file.path === 'new.txt')?.untracked, true)
  const diff = await repositoryFullDiff(root)
  assert.match(diff, /after staged/)
  assert.match(diff, /after working/)
  assert.match(diff, /new\.txt/)
})
