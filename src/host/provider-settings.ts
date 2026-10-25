import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

import { providerSettings, mergeProviderSettings, type ProviderSettings } from '../provider-settings.ts'
export { providerSettings } from '../provider-settings.ts'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function desktopStatePath(): string | undefined {
  if (process.env.SHUN_USER_DATA) return join(process.env.SHUN_USER_DATA, 'state.json')
  if (process.env.SHUN_HOME) return undefined // Explicit profiles must remain isolated.
  const root = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  if (!root) return undefined
  return [join(root, 'shun', 'state.json'), join(root, 'Shun', 'state.json')].find(path => existsSync(path)) || join(root, 'shun', 'state.json')
}

export function providerSettingsPath(root: string) {
  return join(process.env.SHUN_USER_DATA || root, 'providers.json')
}

type Document = { config: ProviderSettings; legacy?: ProviderSettings; sharedDesktop?: boolean }
export class ProviderSettingsStore {
  private legacyCache?: { stamp: string; settings: ProviderSettings }
  readonly file: string
  private legacyFile?: string
  private sharedDesktop: boolean
  constructor(file: string, legacyFile?: string, sharedDesktop = false) { this.file = file; this.legacyFile = legacyFile; this.sharedDesktop = sharedDesktop }
  private async legacy(): Promise<ProviderSettings | undefined> {
    if (!this.legacyFile) return
    try {
      const info = await stat(this.legacyFile), stamp = `${info.mtimeMs}:${info.size}`
      if (this.legacyCache?.stamp === stamp) return this.legacyCache.settings
      const state = JSON.parse(await readFile(this.legacyFile, 'utf8'))
      if (!Array.isArray(state.settings?.providers)) return
      const settings = providerSettings(state.settings)
      this.legacyCache = { stamp, settings }
      return settings
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('Shun could not read the desktop provider settings.'); }
  }
  async sync(fallback: ProviderSettings, update?: { next: ProviderSettings; base: ProviderSettings }): Promise<ProviderSettings> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const lock = `${this.file}.lock`, deadline = Date.now() + 5000
    for (;;) {
      try { await mkdir(lock); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // Only short filesystem operations run under this lock.
        const info = await stat(lock).catch(() => undefined)
        if (info && Date.now() - info.mtimeMs > 60000) { await rm(lock, { recursive: true, force: true }); continue }
        if (Date.now() > deadline) throw Error('Shun provider settings are busy. Try again.')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    try {
      let doc: Document | undefined
      try { doc = JSON.parse(await readFile(this.file, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      const legacy = doc?.sharedDesktop ? undefined : await this.legacy()
      if (!doc) doc = { config: legacy?.providers.length ? legacy : fallback, legacy }
      else if (legacy && !same(legacy, doc.legacy)) {
        doc.config = mergeProviderSettings(doc.config, legacy, doc.legacy || { ...legacy, providers: [], providerId: '', model: '', endpoint: '', apiKey: '' })
        doc.legacy = legacy
      }
      if (update) doc.config = mergeProviderSettings(doc.config, update.next, update.base)
      if (this.sharedDesktop) doc.sharedDesktop = true
      const bytes = JSON.stringify(doc), temporary = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temporary, bytes, { mode: 0o600 })
      await rename(temporary, this.file)
      return structuredClone(doc.config)
    } finally { await rm(lock, { recursive: true, force: true }) }
  }
}
