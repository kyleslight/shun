import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { PluginViewDescriptor } from '../shared.ts'

function globExpression(pattern: string) {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      index++
      if (pattern[index + 1] === '/') { index++; source += '(?:.*/)?' }
      else source += '.*'
    } else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`, 'iu')
}

export function validPluginFileChangePattern(value: unknown) {
  const pattern = String(value || '').trim().replace(/\\/g, '/')
  if (!pattern || pattern.length > 160 || pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern)) return false
  if (pattern.split('/').some(part => part === '..' || !part)) return false
  return !/[\[\]{}\0]/.test(pattern)
}

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
