import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ShunHostService } from '../host/service.ts'
import { selectModel } from './model-selection.ts'

test('terminal model choice survives service restart and becomes the new conversation default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'shun-model-selection-'))
  let service = new ShunHostService(home)
  try {
    await service.initialize()
    const call = service.call.bind(service)
    const config = await call('provider.save', { name: 'Fixture', endpoint: 'http://127.0.0.1:19999/v1' })
    const providerId = config.providers[0].id
    await selectModel(call, providerId, 'original')
    const oldTask = await call('task.create', { workspace: '' })
    const current = await call('task.create', { workspace: '' })
    await selectModel(call, providerId, 'chosen', current.id)
    await service.close()
    service = new ShunHostService(home)
    await service.initialize()
    assert.equal((await service.call('task.snapshot', { taskId: current.id })).task.model, 'chosen')
    assert.equal((await service.call('task.snapshot', { taskId: oldTask.id })).task.model, 'original')
    const next = await service.call('task.create', { workspace: '' })
    assert.equal(next.model, 'chosen')
    assert.equal(next.providerId, providerId)
    await assert.rejects(selectModel(service.call.bind(service), providerId, 'rejected', 'missing-task'))
    assert.equal((await service.call('task.create', { workspace: '' })).model, 'chosen')
  } finally {
    await service.close()
    await rm(home, { recursive: true, force: true })
  }
})
