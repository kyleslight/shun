import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { loadSkillsFromDir } from '@earendil-works/pi-coding-agent'
import { PluginPackageRegistry } from '../main/plugin-packages.ts'
import { packageAgentTools } from '../main/plugin-tools.ts'
import { runPluginWorker } from '../main/plugin-worker.ts'
import { ensurePluginRuntimeExecutable } from '../main/plugin-runtime-assets.ts'
import type { Settings } from '../shared.ts'
import { desktopStatePath } from './provider-settings.ts'

/** Package workers and Skills do not need a renderer or a desktop process. */
export async function hostPackageCapabilities(root: string, settings: Settings, taskId: string, cwd: string, shareDesktop: boolean) {
  const statePath = shareDesktop ? desktopStatePath() : undefined
  let configuration = settings
  if (statePath) {
    try {
      const desktop = JSON.parse(await readFile(statePath, 'utf8')).settings
      configuration = { ...settings, plugins: desktop.plugins, skills: desktop.skills, pluginDefaultsVersion: desktop.pluginDefaultsVersion }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Could not load Shun plugin configuration.') }
  }
  const installedRoot = statePath ? join(dirname(statePath), 'plugins') : join(root, 'plugins')
  const registry = new PluginPackageRegistry(join(root, 'bundled-plugins'), installedRoot)
  await registry.refresh()
  const ids = new Set(registry.states(configuration).filter(item => item.enabled).map(item => item.id))
  const tools = packageAgentTools(registry, configuration, ids, settings.workspace, async (pluginId, workerId, input) => {
    const worker = registry.worker(pluginId, workerId)
    const runtime = Object.fromEntries(await Promise.all(worker.runtime.map(async id => [id, await ensurePluginRuntimeExecutable(registry.runtimeExecutable(pluginId, id), fetch)])))
    await mkdir(cwd, { recursive: true })
    return (await runPluginWorker({ entry: worker.entry, workspace: cwd, input, timeoutMs: worker.timeoutMs, runtime, cacheDirectory: join(root, 'plugin-cache', pluginId), slotKey: `${taskId}\0${pluginId}\0${workerId}` })).value
  })
  const skills = registry.skillDirectories(configuration).flatMap(item => loadSkillsFromDir({ dir: item.path, source: 'product-plugin' }).skills)
  return { tools, skills, configuration }
}
