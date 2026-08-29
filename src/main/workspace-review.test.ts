import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectWorkspaceFiles, ensureWorkspaceBaseline, snapshotPatches, workspaceReviewDiff, workspaceReviewOverview, workspaceSnapshotDiff } from './workspace-review.ts'

test('workspace collection sees scaffold and shell-created source while excluding generated trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-review-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules/pkg'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await mkdir(join(root, 'release/linux/linux-unpacked/resources'), { recursive: true })
  await writeFile(join(root, 'package.json'), '{"scripts":{"dev":"vite"}}')
  await writeFile(join(root, 'tsconfig.json'), '{}')
  await writeFile(join(root, 'src/main.tsx'), 'export const app = true\n')
  await writeFile(join(root, 'node_modules/pkg/index.js'), 'generated')
  await writeFile(join(root, 'dist/index.js'), 'generated')
  await writeFile(join(root, 'release/linux/linux-unpacked/resources/app.asar'), 'generated installer')
  assert.deepEqual(Object.keys(await collectWorkspaceFiles(root)), ['package.json', 'src/main.tsx', 'tsconfig.json'])
})

test('non-git task baseline reports added, edited, and deleted files regardless of producing tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-review-baseline-'))
  const store = await mkdtemp(join(tmpdir(), 'shun-review-store-'))
  await writeFile(join(root, 'existing.txt'), 'before\n')
  await writeFile(join(root, 'deleted.txt'), 'remove me\n')
  await ensureWorkspaceBaseline(root, 'task-a', store)
  await writeFile(join(root, 'existing.txt'), 'after\n')
  await writeFile(join(root, 'created-by-bash.ts'), 'export {}\n')
  const { rm } = await import('node:fs/promises')
  await rm(join(root, 'deleted.txt'))
  const diff = await workspaceSnapshotDiff(root, 'task-a', store)
  assert.match(diff, /created-by-bash\.ts/)
  assert.match(diff, /existing\.txt/)
  assert.match(diff, /deleted\.txt/)
  assert.match(diff, /\+export \{\}/)
  assert.match(diff, /-before/)
  assert.match(diff, /\+after/)
})

test('legacy tasks without a baseline review the complete bounded source tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-review-legacy-'))
  const store = await mkdtemp(join(tmpdir(), 'shun-review-store-'))
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, 'vite.config.ts'), 'export default {}')
  const diff = await workspaceSnapshotDiff(root, 'old-task', store, ['vite.config.ts'])
  assert.match(diff, /package\.json/)
  assert.match(diff, /vite\.config\.ts/)
})

test('snapshot patch construction is stable and omits unchanged files', () => {
  const diff = snapshotPatches({ 'same.ts': 'same', 'edit.ts': 'old' }, { 'same.ts': 'same', 'edit.ts': 'new' })
  assert.doesNotMatch(diff, /same\.ts/)
  assert.match(diff, /edit\.ts/)
})

test('workspace review exposes task-scoped added, modified, and deleted files with focused diffs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-review-overview-'))
  const store = await mkdtemp(join(tmpdir(), 'shun-review-store-'))
  await writeFile(join(root, 'edited.txt'), 'before\n')
  await writeFile(join(root, 'deleted.txt'), 'delete\n')
  await ensureWorkspaceBaseline(root, 'task-review', store)
  await writeFile(join(root, 'edited.txt'), 'after\n')
  await writeFile(join(root, 'added.txt'), 'added\n')
  const { rm } = await import('node:fs/promises')
  await rm(join(root, 'deleted.txt'))

  const overview = await workspaceReviewOverview(root, 'task-review', store)
  assert.deepEqual(overview.files, [
    { path: 'added.txt', status: 'A' },
    { path: 'deleted.txt', status: 'D' },
    { path: 'edited.txt', status: 'M' },
  ])
  assert.match(await workspaceReviewDiff(root, 'task-review', store, 'edited.txt'), /-before[\s\S]*\+after/)
  assert.match(await workspaceReviewDiff(root, 'task-review', store, 'deleted.txt'), /-delete/)
  await assert.rejects(workspaceReviewDiff(root, 'task-review', store, '../outside.txt'), /escapes workspace/)
})

test('workspace review lists changed binary artifacts without putting bytes in a text diff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-review-binary-'))
  const store = await mkdtemp(join(tmpdir(), 'shun-review-store-'))
  await ensureWorkspaceBaseline(root, 'task-binary', store)
  await writeFile(join(root, 'preview.pdf'), Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 1, 2, 3])]))

  assert.deepEqual((await workspaceReviewOverview(root, 'task-binary', store)).files, [{ path: 'preview.pdf', status: 'A' }])
  assert.equal(await workspaceReviewDiff(root, 'task-binary', store, 'preview.pdf'), 'Binary file preview.pdf was added.')
  assert.match(await workspaceSnapshotDiff(root, 'task-binary', store), /Binary file preview\.pdf was added\./)
})

test('opening workspace review before a task run establishes an empty baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-review-first-open-'))
  const store = await mkdtemp(join(tmpdir(), 'shun-review-store-'))
  await writeFile(join(root, 'existing.txt'), 'existing\n')
  assert.deepEqual((await workspaceReviewOverview(root, 'task-new', store)).files, [])
  await writeFile(join(root, 'existing.txt'), 'changed\n')
  assert.deepEqual((await workspaceReviewOverview(root, 'task-new', store)).files, [{ path: 'existing.txt', status: 'M' }])
})
