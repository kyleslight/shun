const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopbackHttpUrl(value: unknown) {
  try {
    const url = new URL(String(value || ''))
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
      && LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function browserDebugUrl(value: unknown) {
  if (String(value || '').length > 2_048) throw Error('browser_debug URL is too long.')
  if (!isLoopbackHttpUrl(value)) throw Error('browser_debug only accepts localhost, 127.0.0.1, or ::1 HTTP(S) URLs.')
  const url = new URL(String(value))
  url.hash = ''
  return url.href
}

export function browserDebugWait(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(5_000, Math.floor(number))) : 700
}
