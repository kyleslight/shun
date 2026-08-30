import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { monitorWorkspace, requireWorkspace, WorkspaceUnavailableError, workspaceAvailability } from './workspace-lifecycle.ts'

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
    await new Promise(resolve => setTimeout(resolve, 30))
    stop()
    assert.ok(error)
    assert.equal(error.workspace, workspace)
    assert.match(error.message, /Workspace moved or deleted/)
    assert.equal((await workspaceAvailability(moved)).available, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
