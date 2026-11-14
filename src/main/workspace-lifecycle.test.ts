import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareTaskWorkspace, monitorWorkspace, requireWorkspace, WorkspaceUnavailableError, workspaceAvailability } from './workspace-lifecycle.ts'

test('workspace availability distinguishes directories from missing paths and files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-lifecycle-'))
  try {
    const workspace = join(root, 'workspace'), file = join(root, 'file.txt')
    await mkdir(workspace)
    await writeFile(file, 'not a workspace')
    assert.equal((await workspaceAvailability(workspace)).available, true)
    assert.deepEqual(await workspaceAvailability(join(root, 'missing')), { available: false, path: join(root, 'missing'), reason: 'missing' })
    assert.deepEqual(await workspaceAvailability(file), { available: false, path: file, reason: 'not-directory' })
    await assert.rejects(requireWorkspace(join(root, 'missing')), WorkspaceUnavailableError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('active workspace monitoring reports a move without searching for the new location', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-monitor-'))
  try {
    const workspace = join(root, 'workspace'), moved = join(root, 'moved')
    await mkdir(workspace)
    let error: WorkspaceUnavailableError | undefined
    const stop = await monitorWorkspace(workspace, unavailable => { error = unavailable }, 10)
    await rename(workspace, moved)
    const deadline = Date.now() + 2000
    while (!error && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    stop()
    assert.ok(error)
    assert.equal(error.workspace, workspace)
    assert.match(error.message, /Workspace moved or deleted/)
    assert.equal((await workspaceAvailability(moved)).available, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('new project directories are prepared explicitly before task launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-new-project-'))
  try {
    const path = join(root, 'projects', 'new-project')
    await assert.rejects(prepareTaskWorkspace(path), WorkspaceUnavailableError)
    assert.equal(await prepareTaskWorkspace(path, true), path)
    assert.equal(await prepareTaskWorkspace(path), path)
    await assert.rejects(prepareTaskWorkspace(undefined, true), /workspace path/)
    const file = join(root, 'file')
    await writeFile(file, 'preserve')
    await assert.rejects(prepareTaskWorkspace(file, true))
  } finally { await rm(root, { recursive: true, force: true }) }
})
