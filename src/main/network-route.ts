import { BlockList, isIP } from 'node:net'

const localAddresses = new BlockList()
for (const [address, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16]] as const)
  localAddresses.addSubnet(address, prefix, 'ipv4')
localAddresses.addAddress('::1', 'ipv6')
localAddresses.addSubnet('fc00::', 7, 'ipv6')
localAddresses.addSubnet('fe80::', 10, 'ipv6')

/** Literal LAN addresses and local names have no reason to visit an Internet proxy. */
export function isLocalNetworkUrl(value: string): boolean {
  let url: URL
  try { url = new URL(value) } catch { return false }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const family = isIP(host)
  return family !== 0 && localAddresses.check(host, family === 4 ? 'ipv4' : 'ipv6')
}

/** Keep the system route for public services and an isolated direct route for LAN services. */
export function createNetworkFetch(systemFetch: typeof fetch, createLocalFetch: () => Promise<typeof fetch>): typeof fetch {
  let localFetch: Promise<typeof fetch> | undefined
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isLocalNetworkUrl(url)) return systemFetch(input, init)
    localFetch ??= createLocalFetch().catch(error => { localFetch = undefined; throw error })
    return (await localFetch)(input, init)
  }) as typeof fetch
}
