const REMOTE_RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

export function remoteReconnectDelay(attempt: number, random = Math.random) {
  const base = REMOTE_RECONNECT_DELAYS[Math.min(Math.max(0, attempt), REMOTE_RECONNECT_DELAYS.length - 1)]
  return Math.max(250, Math.round(base * (0.8 + random() * 0.4)))
}
