import type { Agent } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import WebSocket from 'ws'

export type ProxyRoute =
  | { kind: 'direct' }
  | { kind: 'http'; url: string }
  | { kind: 'socks'; url: string }

/**
 * Read one PAC decision from `session.resolveProxy`.
 *
 * The answer depends on the scheme the host asks about, and the relay is a
 * `wss://` endpoint: a machine that serves HTTP and SOCKS on one local port is
 * told `SOCKS5 127.0.0.1:7897`, never `PROXY ...`. Reading only `PROXY` does not
 * fall back to a working default — it silently connects directly, which is
 * exactly what a proxied network cannot do, and the failure arrives as an
 * `AggregateError` naming no host.
 */
export function parseProxyRoute(value: string | undefined): ProxyRoute {
  for (const entry of String(value ?? '').split(';')) {
    const [kind = '', endpoint = ''] = entry.trim().split(/\s+/)
    if (/^DIRECT$/i.test(kind)) return { kind: 'direct' }
    if (!endpoint) continue
    const scheme = proxySchemes[kind.toUpperCase()]
    if (scheme) return { kind: scheme.kind, url: `${scheme.scheme}://${endpoint}` }
  }
  return { kind: 'direct' }
}

/**
 * Read an explicitly configured proxy, which is a URL rather than a PAC list.
 * `socks5h` matters here: the relay hostname should be resolved by the proxy on
 * a network where local DNS may answer with an unroutable address.
 */
export function environmentProxyRoute(value: string | undefined): ProxyRoute | undefined {
  const configured = String(value ?? '').trim()
  if (!configured) return undefined
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(configured)?.[1]?.toLowerCase()
  if (!scheme) return { kind: 'http', url: `http://${configured}` }
  if (['http', 'https'].includes(scheme)) return { kind: 'http', url: configured }
  if (['socks', 'socks4', 'socks4a', 'socks5', 'socks5h'].includes(scheme)) return { kind: 'socks', url: configured }
  return undefined
}

export function proxyAgent(route: ProxyRoute): Agent | undefined {
  if (route.kind === 'direct') return undefined
  return route.kind === 'socks' ? new SocksProxyAgent(route.url) : new HttpsProxyAgent(route.url)
}

/**
 * A failed relay connection is shown to the person waiting for a pairing code,
 * so it names the relay and the route that was tried. Node reports a failed
 * direct connection as an `AggregateError` with an empty message, which says
 * nothing about what to fix.
 */
export function relayConnectionError(error: unknown, url: string, route: ProxyRoute) {
  const failures = (error as { errors?: unknown[] } | undefined)?.errors
  const detail = Array.isArray(failures) && failures.length > 0
    ? failures.slice(0, 2).map(item => (item instanceof Error ? item.message : String(item))).join('; ')
    : error instanceof Error ? error.message : String(error)
  const through = route.kind === 'direct'
    ? 'a direct connection'
    : `${route.kind === 'socks' ? 'the SOCKS proxy' : 'the HTTP proxy'} ${route.url}`
  return new Error(`Could not reach ${new URL(url).origin} through ${through}: ${detail || 'no response'}`, { cause: error })
}

const proxySchemes: Record<string, { kind: 'http' | 'socks'; scheme: string }> = {
  PROXY: { kind: 'http', scheme: 'http' },
  HTTPS: { kind: 'http', scheme: 'https' },
  SOCKS: { kind: 'socks', scheme: 'socks5h' },
  SOCKS5: { kind: 'socks', scheme: 'socks5h' },
  SOCKS4: { kind: 'socks', scheme: 'socks4' },
}

/** A dial that never finishes opening is not a connection, so it fails like one. */
export const RELAY_CONNECT_TIMEOUT_MS = 15_000

export type RelayDialer = {
  open(url: string): Promise<WebSocket>
  dispose(): void
}

/**
 * Both ends of a Remote link dial the same relay under the same rules: the
 * proxy the network actually chose, a bounded dial, and an error that names the
 * route it tried. Keeping that in one place means a fix to proxy handling
 * cannot land on only one side of the link.
 */
export function createRelayDialer(resolveProxy?: (url: string) => Promise<string>): RelayDialer {
  const agents = new Map<string, Agent>()
  const routeFor = async (url: string): Promise<ProxyRoute> => {
    const configured = environmentProxyRoute(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy)
    return configured ?? parseProxyRoute(await resolveProxy?.(url))
  }
  const agentFor = (route: ProxyRoute) => {
    if (route.kind === 'direct') return undefined
    const cached = agents.get(route.url)
    if (cached) return cached
    const agent = proxyAgent(route)
    if (agent) agents.set(route.url, agent)
    return agent
  }
  return {
    async open(url) {
      const route = await routeFor(url)
      const agent = agentFor(route)
      return new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url, agent ? { agent } : undefined)
        const timer = setTimeout(() => { socket.terminate(); reject(Error('Relay connection timed out.')) }, RELAY_CONNECT_TIMEOUT_MS)
        socket.once('open', () => { clearTimeout(timer); resolve(socket) })
        socket.once('error', error => { clearTimeout(timer); reject(relayConnectionError(error, url, route)) })
      })
    },
    dispose() {
      for (const agent of agents.values()) agent.destroy()
      agents.clear()
    },
  }
}

export function sendWebSocketMessage(socket: WebSocket, value: string) {
  return new Promise<void>((resolve, reject) => socket.send(value, error => error ? reject(error) : resolve()))
}
