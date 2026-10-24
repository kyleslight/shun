/** Font icons may occur in accessible names but do not change their visible text. */
export function browserControlNamesMatch(actual: string, requested: string) {
  const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
  const observed = normalize(actual), expected = normalize(requested)
  if (observed === expected) return true
  const withoutIcons = (value: string) => normalize(value.replace(/\p{Private_Use}/gu, ''))
  const text = withoutIcons(observed)
  return Boolean(text) && text === withoutIcons(expected)
}
