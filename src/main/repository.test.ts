import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { gitCommitFiles, gitWorkbenchDiff, gitWorkbenchExecute, gitWorkbenchFilePreview, gitWorkbenchOverview, gitWorkbenchOverviewState, parseGitChangedFiles, parseGitReferences, parsePorcelainV2, repositoryFullDiff, repositoryRoot, repositorySnapshot } from './repository.ts'

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

test('repository root distinguishes Git and plain workspaces without reading the source tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-repository-root-'))
  const plain = await mkdtemp(join(tmpdir(), 'shun-plain-workspace-'))
  await execFile('git', ['init'], { cwd: root })
  assert.equal(await repositoryRoot(root), await realpath(root))
  assert.equal(await repositoryRoot(plain), null)
  await Promise.all([root, plain].map(path => rm(path, { recursive: true, force: true })))
})

test('Git workbench lazily exposes refs, topology metadata, files, and focused diffs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-git-workbench-'))
  await execFile('git', ['init'], { cwd: root })
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFile('git', ['config', 'user.name', 'Test Author'], { cwd: root })
  await writeFile(join(root, 'tracked.txt'), 'first\n')
  await execFile('git', ['add', '.'], { cwd: root })
  await execFile('git', ['commit', '-m', 'initial commit'], { cwd: root })
  await execFile('git', ['tag', 'v0.1.0'], { cwd: root })
  await writeFile(join(root, 'tracked.txt'), 'first\nsecond\n')
  await execFile('git', ['commit', '-am', 'add second line'], { cwd: root })
  await execFile('git', ['remote', 'add', 'origin', 'https://example.com/acme/repo.git'], { cwd: root })
  await writeFile(join(root, 'working.txt'), 'working\n')

  const overview = await gitWorkbenchOverview(root, { limit: 25 })
  assert.equal(overview.commits.length, 2)
  assert.equal(overview.commits[0].subject, 'add second line')
  assert.equal(overview.commits[0].parents.length, 1)
  assert.equal(overview.refs.some(ref => ref.kind === 'branch' && ref.current), true)
  assert.equal(overview.refs.some(ref => ref.kind === 'tag' && ref.name === 'v0.1.0'), true)
  assert.deepEqual(overview.remotes, [{ name: 'origin', fetchUrl: 'https://example.com/acme/repo.git', pushUrl: 'https://example.com/acme/repo.git' }])
  assert.equal((await gitWorkbenchOverview(root, { ref: 'HEAD', limit: 25 })).commits[0].oid, overview.commits[0].oid)

  const details = await gitCommitFiles(root, overview.commits[0].oid)
  assert.deepEqual(details.files.map(file => [file.status, file.path]), [['M', 'tracked.txt']])
  assert.match(await gitWorkbenchDiff(root, { revision: overview.commits[0].oid, path: 'tracked.txt' }), /\+second/)
  assert.match(await gitWorkbenchDiff(root, { working: true, path: 'working.txt' }), /\+working/)
})

test('Git workbench parsers keep rename paths and reference kinds structural', () => {
  assert.deepEqual(parseGitChangedFiles('R100\0before.txt\0after.txt\0M\0same.txt\0'), [
    { path: 'after.txt', previousPath: 'before.txt', status: 'R100' },
    { path: 'same.txt', status: 'M' },
  ])
  assert.deepEqual(parseGitReferences('refs/heads/main\0main\0abc\0origin/main\0*\nrefs/tags/v1\0v1\0def\0\0\n').map(ref => [ref.kind, ref.name, ref.current]), [
    ['branch', 'main', true], ['tag', 'v1', undefined],
  ])
})

test('Git workbench previews bounded images from commits, the working tree, and deletion commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-git-preview-'))
  await execFile('git', ['init'], { cwd: root })
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFile('git', ['config', 'user.name', 'Test Author'], { cwd: root })
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  await writeFile(join(root, 'preview.png'), Buffer.concat([signature, Buffer.from('committed')]))
  await execFile('git', ['add', '.'], { cwd: root })
  await execFile('git', ['commit', '-m', 'image'], { cwd: root })
  const oid = (await repositorySnapshot(root))!.oid
  await writeFile(join(root, 'preview.png'), Buffer.concat([signature, Buffer.from('working')]))

  const committed = await gitWorkbenchFilePreview(root, { revision: oid, path: 'preview.png' })
  const working = await gitWorkbenchFilePreview(root, { working: true, path: 'preview.png' })
  assert.equal(committed.mimeType, 'image/png')
  assert.match(Buffer.from(committed.data, 'base64').toString('latin1'), /committed/)
  assert.match(Buffer.from(working.data, 'base64').toString('latin1'), /working/)

  await rm(join(root, 'preview.png'))
  await execFile('git', ['commit', '-am', 'delete image'], { cwd: root })
  const deletionOid = (await repositorySnapshot(root))!.oid
  const deleted = await gitWorkbenchFilePreview(root, { revision: deletionOid, path: 'preview.png', status: 'D' })
  assert.match(Buffer.from(deleted.data, 'base64').toString('latin1'), /committed/)
  await assert.rejects(gitWorkbenchFilePreview(root, { working: true, path: '../outside.png' }), /Invalid repository path/)
})

test('Git workbench reports a non-repository workspace and initializes it only through an explicit action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-git-empty-'))
  assert.deepEqual(await gitWorkbenchOverviewState(root), { unavailable: 'not-repository' })

  const initialized = await gitWorkbenchExecute(root, { action: 'init' })
  assert.equal(initialized.action, 'init')
  const overview = await gitWorkbenchOverviewState(root)
  assert.equal('unavailable' in overview, false)
  if ('unavailable' in overview) assert.fail('Expected an initialized repository overview.')
  assert.equal(overview.repository.root, (await execFile('git', ['rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim())
  assert.deepEqual(overview.commits, [])
  const headOverview = await gitWorkbenchOverviewState(root, { ref: 'HEAD' })
  assert.equal('unavailable' in headOverview, false)
  if ('unavailable' in headOverview) assert.fail('Expected an unborn HEAD overview.')
  assert.deepEqual(headOverview.commits, [])
  await assert.rejects(gitWorkbenchExecute(root, { action: 'init' }), /already belongs/)
})

test('Git workbench write actions are structured and remain scoped to current changes and refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-git-actions-'))
  await execFile('git', ['init'], { cwd: root })
  await execFile('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  await execFile('git', ['config', 'user.name', 'Test Author'], { cwd: root })
  await writeFile(join(root, 'tracked.txt'), 'first\n')
  await execFile('git', ['add', '.'], { cwd: root })
  await execFile('git', ['commit', '-m', 'initial'], { cwd: root })
  await writeFile(join(root, 'tracked.txt'), 'second\n')

  await gitWorkbenchExecute(root, { action: 'stage', paths: ['tracked.txt'] })
  assert.equal((await repositorySnapshot(root))?.files[0]?.staged, true)
  await gitWorkbenchExecute(root, { action: 'commit', message: 'structured commit' })
  assert.equal((await gitWorkbenchOverview(root)).commits[0]?.subject, 'structured commit')
  const oid = (await repositorySnapshot(root))!.oid
  await gitWorkbenchExecute(root, { action: 'create-branch', name: 'feature/test', ref: oid })
  assert.equal((await repositorySnapshot(root))?.head, 'feature/test')

  await writeFile(join(root, 'tracked.txt'), 'third\n')
  await execFile('git', ['commit', '-am', 'later commit'], { cwd: root })
  await gitWorkbenchExecute(root, { action: 'reset', mode: 'mixed', ref: oid })
  assert.equal((await repositorySnapshot(root))?.oid, oid)
  assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'third\n')
  await gitWorkbenchExecute(root, { action: 'reset-file', paths: ['tracked.txt'] })
  assert.equal(await readFile(join(root, 'tracked.txt'), 'utf8'), 'second\n')

  await writeFile(join(root, 'untracked.txt'), 'temporary\n')
  await gitWorkbenchExecute(root, { action: 'reset-file', paths: ['untracked.txt'] })
  await assert.rejects(readFile(join(root, 'untracked.txt')), /ENOENT/)

  await writeFile(join(root, 'staged-new.txt'), 'temporary staged file\n')
  await execFile('git', ['add', 'staged-new.txt'], { cwd: root })
  await gitWorkbenchExecute(root, { action: 'reset-file', paths: ['staged-new.txt'] })
  await assert.rejects(readFile(join(root, 'staged-new.txt')), /ENOENT/)

  await assert.rejects(gitWorkbenchExecute(root, { action: 'stage', paths: ['../outside'] }), /Invalid repository path/)
  await assert.rejects(gitWorkbenchExecute(root, { action: 'create-branch', name: '--upload-pack=bad' }), /Invalid Git branch name/)
  await assert.rejects(gitWorkbenchExecute(root, { action: 'reset', mode: 'erase', ref: oid }), /Reset mode/)
  await assert.rejects(gitWorkbenchExecute(root, { action: 'shell', command: 'anything' }), /Unsupported Git action/)
})

test('file-scoped Git actions avoid a repository-wide status scan', async () => {
  const source = await readFile(new URL('./repository.ts', import.meta.url), 'utf8')
  const scoped = source.slice(source.indexOf('async function scopedChangedPaths'), source.indexOf('function normalizeGitMessage'))
  assert.match(scoped, /'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', \.\.\.paths/)
  assert.doesNotMatch(scoped, /repositorySnapshot/)
})
