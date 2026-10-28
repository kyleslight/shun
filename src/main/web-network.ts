import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

function proxyUrl(value: unknown): string | undefined {
  if (value === '') return ''
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) return undefined
    return url.href
  } catch { return undefined }
}

/** Deployment-owned routing for public HTTP tools; read live, independent of model/browser routing. */
export async function configuredWebProxy(home: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.SHUN_WEB_PROXY !== undefined) return proxyUrl(env.SHUN_WEB_PROXY)
  try {
    const configuration = JSON.parse(await readFile(join(home, 'web-network.json'), 'utf8'))
    return proxyUrl(configuration.publicProxyUrl)
  } catch { return undefined }
}
