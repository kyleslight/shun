import type { HostCall } from '../host/protocol.ts'

/** Remember the explicit terminal choice for subsequent conversations too. */
export async function selectModel(call: HostCall, providerId: string, model: string, taskId?: string) {
  // Apply the task selection first: a rejected change must not alter defaults.
  if (taskId) await call('model.select', { providerId, model, taskId })
  return call('model.select', { providerId, model })
}
