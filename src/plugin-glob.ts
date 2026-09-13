/**
 * Workspace-relative glob validation, with no platform dependency: the manifest
 * contract uses it when a package declares which file changes activate a view,
 * and the application uses the same rule when it matches a real path.
 */
export function validPluginFileChangePattern(value: unknown) {
  const pattern = String(value || '').trim().replace(/\\/g, '/')
  if (!pattern || pattern.length > 160 || pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern)) return false
  if (pattern.split('/').some(part => part === '..' || !part)) return false
  return !/[\[\]{}\0]/.test(pattern)
}

export function globExpression(pattern: string) {
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
