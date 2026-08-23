import { lstat, mkdir, readdir, rename, rmdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export type AgentRuntimePaths = {
  root: string
  agentDir: string
  sessionDir: string
  standaloneDir: string
}

export function agentRuntimeHome(homeDirectory: string, override = ''): AgentRuntimePaths {
  const root = resolve(override || join(homeDirectory, '.shun'))
  return {
    root,
    agentDir: root,
    sessionDir: join(root, 'sessions'),
    standaloneDir: join(root, 'standalone'),
  }
}

export async function migrateLegacyAgentRuntime(legacyRootValue: string, destination: AgentRuntimePaths) {
  const legacyRoot = resolve(legacyRootValue)
  if (legacyRoot === destination.root) return []
  const conflicts: string[] = []
  await mkdir(destination.root, { recursive: true })
  await mergeMove(join(legacyRoot, 'agent'), destination.agentDir, conflicts, destination.root)
  await mergeMove(join(legacyRoot, 'sessions'), destination.sessionDir, conflicts, destination.root)
  await mergeMove(join(legacyRoot, 'standalone'), destination.standaloneDir, conflicts, destination.root)
  await removeEmptyDirectory(legacyRoot)
  return conflicts
}

async function mergeMove(source: string, destination: string, conflicts: string[], displayRoot: string): Promise<void> {
  const sourceInfo = await info(source)
  if (!sourceInfo) return
  const destinationInfo = await info(destination)
  if (!destinationInfo) {
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
    return
  }
  if (!sourceInfo.isDirectory() || !destinationInfo.isDirectory()) {
    conflicts.push(destination.startsWith(displayRoot) ? destination.slice(displayRoot.length + 1) : destination)
    return
  }
  for (const entry of await readdir(source)) await mergeMove(join(source, entry), join(destination, entry), conflicts, displayRoot)
  await removeEmptyDirectory(source)
}

async function info(path: string) {
  try { return await lstat(path) } catch { return null }
}

async function removeEmptyDirectory(path: string) {
  try { await rmdir(path) } catch {}
}
