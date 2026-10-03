import assert from 'node:assert/strict'
import test from 'node:test'
import { externalLinkUrl, hasContinuationState, installMissingBundledPlugins, hasTaskContent, hasTaskMessages, isSoftNotFoundSource, isTaskWorkspaceLocked, keepCurrentDraft, latestProviderFailure, latestUnsentTask, maxGoalContinuations, nextTaskWorkspace, normalizeTaskGoal, workspaceLabel, type Task, type ToolEvent } from '../shared.ts'

test('new tasks inherit the selected project unless standalone was explicitly chosen', () => {
  assert.equal(nextTaskWorkspace(undefined, '/current', '/remembered'), '/current')
  assert.equal(nextTaskWorkspace(undefined, undefined, '/remembered'), '/remembered')
  assert.equal(nextTaskWorkspace('', '/current', '/remembered'), '')
})

test('project labels are the folder name on POSIX and Windows paths', () => {
  assert.equal(workspaceLabel('/Users/kyles/code_pool/shun'), 'shun')
  assert.equal(workspaceLabel('C:\\Users\\w133106\\code_pool\\test_teams_outlook'), 'test_teams_outlook')
  assert.equal(workspaceLabel('C:\\Users\\w133106\\project\\'), 'project')
  assert.equal(workspaceLabel('/Users/kyles/project///'), 'project')
  assert.equal(workspaceLabel('C:\\'), 'C:')
  assert.equal(workspaceLabel('   '), '')
  assert.equal(workspaceLabel(undefined, 'No project'), 'No project')
})

test('the currently selected blank draft survives persistence and reload selection', () => {
  const tasks = [{ id: 'draft', messages: 0 }, { id: 'old', messages: 2 }, { id: 'other-blank', messages: 0 }]
  assert.deepEqual(keepCurrentDraft(tasks, 'draft', task => task.messages > 0).map(task => task.id), ['draft', 'old'])
})

test('unsent text and attachments make a task draft durable across task switches', () => {
  const tasks: Array<Pick<Task, 'id' | 'draft' | 'attachments' | 'turns'>> = [
    { id: 'text-draft', draft: 'unfinished prompt', attachments: [], turns: [] },
    { id: 'attachment-draft', attachments: [{ id: 'image' } as any], turns: [] },
    { id: 'selected', attachments: [], turns: [{ id: 'turn', role: 'user', content: 'sent' }] },
    { id: 'empty', attachments: [], turns: [] },
  ]
  assert.deepEqual(keepCurrentDraft(tasks, 'selected', hasTaskContent).map(task => task.id), ['text-draft', 'attachment-draft', 'selected'])
  assert.deepEqual(tasks.filter(hasTaskMessages).map(task => task.id), ['selected'])
})

test('a remotely-created task stays durable until its first message arrives', () => {
  const task: Task = { id: 'remote-draft', title: 'New task', workspace: '/tmp/project', turns: [], awaitingFirstRemoteMessage: true, createdAt: 1, updatedAt: 1 }
  assert.equal(hasTaskContent(task), true)
  assert.equal(hasTaskContent({ ...task, awaitingFirstRemoteMessage: undefined }), false)
})

test('new task resumes the latest hidden draft without surfacing it in task groups', () => {
  const base = { title: 'New task', attachments: [], turns: [], createdAt: 1 }
  const drafts: Task[] = [
    { ...base, id: 'older', workspace: '/a', draft: 'old', updatedAt: 2 },
    { ...base, id: 'latest', workspace: '/b', draft: 'new', updatedAt: 3 },
  ]
  assert.equal(latestUnsentTask(drafts)?.id, 'latest')
  assert.equal(latestUnsentTask(drafts, '/a')?.id, 'older')
  assert.equal(drafts.filter(hasTaskMessages).length, 0)
})

test('a task project becomes immutable as soon as its conversation starts', () => {
  assert.equal(isTaskWorkspaceLocked({ turns: [] }), false)
  assert.equal(isTaskWorkspaceLocked({ turns: [{ role: 'user', content: 'start' } as any] }), true)
})

test('web source metadata can survive compact tool output in saved task history', () => {
  const source = { requestedUrl: 'https://example.test/a', finalUrl: 'https://example.test/b', title: 'Evidence', contentType: 'text/html', fetchMethod: 'direct' }
  const tool: ToolEvent = { id: '1', name: 'web_read', input: '{"url":"https://example.test/a"}', output: '{"ok":true}', source, state: 'done' }
  assert.deepEqual(JSON.parse(JSON.stringify(tool)).source, source)
})

test('soft 404 source metadata is rejected even when the server returned HTTP 200', () => {
  assert.equal(isSoftNotFoundSource({ finalUrl: 'https://example.test/page-not-found', title: 'Example' }), true)
  assert.equal(isSoftNotFoundSource({ finalUrl: 'https://example.test/article', title: 'Page not found' }), true)
  assert.equal(isSoftNotFoundSource({ finalUrl: 'https://example.test/article', title: 'Actual article' }), false)
})

test('follow-ups retain continuation state after progress or tool activity', () => {
  assert.equal(hasContinuationState([{ progress: undefined, timeline: [], tools: [] }]), false)
  assert.equal(hasContinuationState([{ progress: { stage: 'implementation' } as any, timeline: [], tools: [] }]), true)
  assert.equal(hasContinuationState([{ progress: undefined, timeline: [{ type: 'tool', tool: {} as any }], tools: [] }]), true)
})

test('only the latest assistant failure activates provider recovery on retry', () => {
  assert.equal(latestProviderFailure([
    { role: 'assistant', content: 'Error: Model stream was idle.', error: true },
    { role: 'assistant', content: 'Recovered successfully.', error: false },
  ]), undefined)
  assert.match(latestProviderFailure([
    { role: 'assistant', content: 'Earlier success.', error: false },
    { role: 'assistant', content: 'Error: Model stream had no visible progress for 3 minutes.', error: true },
  ]) || '', /no visible progress/)
})

test('a required-tier package is installed because it is on disk, and an existing choice is never reset', () => {
  const bundled = [{ id: 'gallery', permissions: ['workspace.read'] }, { id: 'sites', permissions: ['workspace.read', 'conversation.context'] }]

  // A package that appeared in a later build is installed without waiting for a
  // migration the user could only obtain by restarting.
  const fresh = installMissingBundledPlugins({ plugins: [{ id: 'terminal', enabled: true }] }, bundled)
  assert.deepEqual(fresh.added, ['gallery', 'sites'])
  assert.deepEqual(fresh.plugins.map(item => item.id), ['terminal', 'gallery', 'sites'])

  // Disabling or reconfiguring a package is a user decision, not a gap to fill.
  const settled = installMissingBundledPlugins({ plugins: [{ id: 'sites', enabled: false, permissions: [] }] }, bundled)
  assert.deepEqual(settled.added, ['gallery'])
  assert.deepEqual(settled.plugins.find(item => item.id === 'sites'), { id: 'sites', enabled: false, permissions: [] })
})

test('only an http(s) link without credentials may be handed to the system browser', () => {
  assert.equal(externalLinkUrl('https://todo.shunagent.site/'), 'https://todo.shunagent.site/')
  assert.equal(externalLinkUrl('http://localhost:8123/x?y=1'), 'http://localhost:8123/x?y=1')
  assert.equal(externalLinkUrl('file:///etc/passwd'), '')
  assert.equal(externalLinkUrl('javascript:alert(1)'), '')
  assert.equal(externalLinkUrl('https://user:secret@example.com/'), '')
  assert.equal(externalLinkUrl('/workspace/notes.md'), '')
  assert.equal(externalLinkUrl(''), '')
  assert.equal(externalLinkUrl(`https://example.com/${'x'.repeat(3_000)}`), '')
})

test('a goal that arrives as data is read, and one nothing can decide is refused', () => {
  const goal = normalizeTaskGoal({ objective: '  Ship the importer  ', checks: [{ kind: 'file', path: 'dist/report.md' }, { kind: 'command', command: 'pnpm test' }] })
  assert.deepEqual(goal, {
    objective: 'Ship the importer',
    checks: [
      { id: 'check-1', kind: 'file', path: 'dist/report.md', description: 'file:dist/report.md' },
      { id: 'check-2', kind: 'command', command: 'pnpm test', description: 'run:pnpm test' },
    ],
  })
  // A condition with no value would hold a run to nothing, so it is refused rather than
  // repaired: a repaired condition is one nobody wrote down.
  assert.equal(normalizeTaskGoal({ objective: 'Ship it', checks: [{ kind: 'file', path: '   ' }] }), undefined)
  assert.equal(normalizeTaskGoal({ objective: '', checks: [{ kind: 'file', path: 'a.md' }] }), undefined)
  // An objective with no condition is the ordinary shape of "do not stop until this holds": it is
  // kept, and it is never dressed up with an invented path to look checkable.
  assert.deepEqual(normalizeTaskGoal({ objective: '拿到赏金', checks: [] }), { objective: '拿到赏金', checks: [] })
  assert.deepEqual(normalizeTaskGoal({ objective: '拿到赏金' }), { objective: '拿到赏金', checks: [] })
  // A reader may call the one field "value".
  assert.deepEqual(normalizeTaskGoal({ objective: 'Ship', checks: [{ kind: 'command', value: 'pnpm test' }] })?.checks, [
    { id: 'check-1', kind: 'command', command: 'pnpm test', description: 'run:pnpm test' },
  ])
  assert.equal(normalizeTaskGoal({ objective: 'Ship it', checks: [{ kind: 'sometimes', path: 'a.md' }] }), undefined)
  assert.equal(normalizeTaskGoal(null), undefined)
  assert.equal(normalizeTaskGoal('Ship it'), undefined)
  // Both bounds are the product's, not the caller's.
  assert.equal(normalizeTaskGoal({ objective: 'x', checks: [{ kind: 'file', path: 'a' }], maxContinuations: 10_000 })?.maxContinuations, maxGoalContinuations)
  assert.equal(normalizeTaskGoal({ objective: 'x', checks: [{ kind: 'file', path: 'a' }], maxContinuations: 0 })?.maxContinuations, 1)
  assert.equal(normalizeTaskGoal({ objective: 'x', checks: [{ kind: 'file', path: 'a' }] })?.maxContinuations, undefined)
})
