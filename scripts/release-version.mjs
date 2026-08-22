export function stableVersion(value) {
  const match = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  return match ? match.slice(1).map(Number) : null
}

export function nextPatchVersion(current, releaseTags = []) {
  const parsedCurrent = stableVersion(current)
  if (!parsedCurrent) throw Error(`Expected a stable semantic version, got ${current}.`)
  const versions = [parsedCurrent, ...releaseTags.map(stableVersion).filter(Boolean)]
  versions.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2])
  const latest = versions.at(-1)
  return `${latest[0]}.${latest[1]}.${latest[2] + 1}`
}
