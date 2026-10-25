import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentRuntimeHome } from '../main/runtime-home.ts'

export function hostPaths(home = process.env.SHUN_HOME) {
  const runtime = agentRuntimeHome(homedir(), home)
  const root = join(runtime.root, 'service')
  const key = createHash('sha256').update(root).digest('hex').slice(0, 24)
  const socketDirectory = Buffer.byteLength(join(root, 'service.sock')) <= 100
    ? root : join(tmpdir(), `shun-${key}`)
  return {
    ...runtime, serviceRoot: root,
    socketDirectory,
    socket: process.platform === 'win32' ? `\\\\.\\pipe\\shun-${key}` : join(socketDirectory, 'ipc'),
    token: join(root, 'access-token'),
    state: join(root, 'state.json'),
    log: join(root, 'service.log'),
  }
}
