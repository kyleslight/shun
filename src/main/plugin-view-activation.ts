import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginViewDescriptor } from '../shared.ts'
import { globExpression, validPluginFileChangePattern } from '../plugin-glob.ts'

export { validPluginFileChangePattern }

export function pluginFileChangeMatches(pattern: string, path: string) {
  if (!validPluginFileChangePattern(pattern)) return false
  return globExpression(pattern).test(path.replace(/\\/g, '/').replace(/^\/+/, ''))
}

export function workspaceRelativeToolPath(cwd: string, pathValue: unknown) {
  const requested = String(pathValue || '').trim()
  if (!requested) return ''
  const target = resolve(cwd, requested), rel = relative(resolve(cwd), target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : target.split(sep).join('/').replace(/^\/+/, '')
}

export function suggestedPluginViewForFileChange(views: PluginViewDescriptor[], path: string) {
  return views.find(view => view.launch.includes('tool-result') && view.activation?.fileChanges?.some(pattern => pluginFileChangeMatches(pattern, path)))
}

export function toolFileChangePath(input: string, cwd: string) {
  try {
    const args = JSON.parse(input)
    return workspaceRelativeToolPath(cwd, args?.path)
  } catch { return '' }
}
