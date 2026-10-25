import assert from 'node:assert/strict'
import test from 'node:test'
import { launchOptions, startSession, chooseSession } from './sessions.ts'

test('startup defaults to no workspace and binds a directory only when explicitly named', () => {
  assert.equal(launchOptions([], '/work').workspace, '')
  assert.equal(launchOptions(['.'], '/work').workspace, '/work')
  assert.equal(launchOptions(['./project', '-c'], '/work').workspace, '/work/project')
  assert.equal(launchOptions(['-c'], '/work').workspace, '')
  assert.equal(launchOptions(['/other'], '/work').workspace, '/other')
  assert.equal(launchOptions(['--no-workspace'], '/work').workspace, '')
  assert.equal(launchOptions(['--workspace', '/other'], '/work').workspace, '/other')
  assert.throws(() => launchOptions(['--workspace', '/other', '--no-workspace'], '/work'))
  assert.throws(() => launchOptions(['-c', '-r'], '/work'))
  assert.throws(() => launchOptions(['.', '--no-workspace'], '/work'))
  assert.throws(() => launchOptions(['--unknown'], '/work'))
})

test('continue selects only the most recent conversation in the launch scope', async () => {
  const tasks = [{ id: 'a', workspace: '/work', updatedAt: 1 }, { id: 'b', workspace: '/work', updatedAt: 3 }, { id: 'c', workspace: '', updatedAt: 9 }]
  const call = async (method: string, input?: any): Promise<any> => method === 'task.list' ? tasks : method === 'task.snapshot' ? { task: tasks.find(task => task.id === input.taskId) } : { id: 'new', ...input }
  const choose = async () => { throw Error('Continue must not show a selector') }
  assert.equal((await startSession(call, { workspace: '/work', continueRecent: true }, choose)).id, 'b')
  assert.equal((await startSession(call, { workspace: '', continueRecent: true }, choose)).id, 'c')
  assert.equal((await startSession(call, { workspace: '/empty', continueRecent: true }, choose)).id, 'new')
  assert.equal((await startSession(call, { workspace: '/work' }, choose)).id, 'new')
})

test('resume starts scoped and exposes other workspaces only through an explicit selection', async () => {
  const tasks = [{ id: 'local', workspace: '/work', title: 'Local' }, { id: 'other', workspace: '/other', title: 'Other' }]
  let step = 0
  const id = await chooseSession(async () => tasks, '/work', async (_label, items) => {
    if (step++ === 0) { assert.ok(items.some(item => item.value === 'local')); assert.ok(!items.some(item => item.value === 'other')); return '__all__' }
    assert.ok(items.some(item => item.value === 'other')); return 'other'
  })
  assert.equal(id, 'other')
})
