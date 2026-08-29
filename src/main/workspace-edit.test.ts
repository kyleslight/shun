import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createEditToolDefinition } from '@earendil-works/pi-coding-agent'
import { createWorkspaceEditTool, editWorkspaceFile } from './workspace-edit.ts'

test('Edit file applies a complete multi-region repair once while skipping already-present work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-edit-'))
  try {
    const path = join(root, 'resume.tex')
    await writeFile(path, 'Header left\nTimeline   right\nQuote fixed\nFooter left\n')
    const result = await editWorkspaceFile(root, 'resume.tex', [
      { oldText: 'Header left', newText: 'Header aligned left' },
      { oldText: 'Timeline\nright', newText: 'Timeline aligned left' },
      { oldText: 'Quote broken', newText: 'Quote fixed' },
      { oldText: 'Footer left', newText: 'Footer aligned left' },
    ])
    assert.equal(await readFile(path, 'utf8'), 'Header aligned left\nTimeline aligned left\nQuote fixed\nFooter aligned left\n')
    assert.equal(result.details.changed, true)
    assert.equal(result.details.applied, 3)
    assert.equal(result.details.alreadyApplied, 1)
    assert.match(result.content[0].text, /one atomic batch/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Edit file leaves the file untouched when any target is genuinely stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-workspace-edit-'))
  try {
    const path = join(root, 'paper.tex'), original = 'First old\nSecond current\n'
    await writeFile(path, original)
    await assert.rejects(editWorkspaceFile(root, 'paper.tex', [
      { oldText: 'First old', newText: 'First new' },
      { oldText: 'Second stale', newText: 'Second new' },
    ]), /complete remaining file change in one edit call/)
    assert.equal(await readFile(path, 'utf8'), original)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('Edit file keeps the agent runtime edit contract while strengthening one-shot guidance', () => {
  const tool = createWorkspaceEditTool('/workspace'), base = createEditToolDefinition('/workspace')
  assert.equal(tool.name, 'edit')
  assert.equal(tool.label, 'Edit file')
  assert.deepEqual(tool.parameters, base.parameters)
  assert.equal(tool.promptSnippet, base.promptSnippet)
  assert.equal(tool.prepareArguments, base.prepareArguments)
  assert.match(tool.promptGuidelines?.join('\n') || '', /exactly one edit call/i)
})
