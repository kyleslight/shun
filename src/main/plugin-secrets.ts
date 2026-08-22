import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface PluginSecretStore {
  get(pluginId: string): Promise<string | undefined>
  set(pluginId: string, value: string): Promise<void>
  delete(pluginId: string): Promise<void>
}

export class MemoryPluginSecretStore implements PluginSecretStore {
  readonly #values = new Map<string, string>()
  async get(pluginId: string) { return this.#values.get(pluginId) }
  async set(pluginId: string, value: string) { this.#values.set(pluginId, value) }
  async delete(pluginId: string) { this.#values.delete(pluginId) }
}

export class EncryptedFilePluginSecretStore implements PluginSecretStore {
  private readonly file: string
  private readonly encrypt: (value: string) => Buffer
  private readonly decrypt: (value: Buffer) => string
  constructor(
    file: string,
    encrypt: (value: string) => Buffer,
    decrypt: (value: Buffer) => string,
  ) { this.file = file; this.encrypt = encrypt; this.decrypt = decrypt }

  async get(pluginId: string) {
    const encoded = (await this.read())[pluginId]
    if (!encoded) return undefined
    try { return this.decrypt(Buffer.from(encoded, 'base64')) } catch { return undefined }
  }

  async set(pluginId: string, value: string) {
    const values = await this.read()
    values[pluginId] = this.encrypt(value).toString('base64')
    await this.write(values)
  }

  async delete(pluginId: string) {
    const values = await this.read()
    if (!(pluginId in values)) return
    delete values[pluginId]
    await this.write(values)
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'))
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch { return {} }
  }

  private async write(values: Record<string, string>) {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(values), { mode: 0o600 })
    await rename(temp, this.file)
  }
}
