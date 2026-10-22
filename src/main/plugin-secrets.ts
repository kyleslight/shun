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
  private pendingWrite: Promise<void> = Promise.resolve()
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
    await this.mutate(values => { values[pluginId] = this.encrypt(value).toString('base64') })
  }

  async delete(pluginId: string) {
    await this.mutate(values => { delete values[pluginId] })
  }

  private mutate(change: (values: Record<string, string>) => void) {
    // Every connector shares this file. Serialize the complete read/modify/write,
    // not only rename, so simultaneous refreshes cannot erase another account.
    const operation = this.pendingWrite.then(async () => {
      const values = await this.read()
      change(values)
      await this.write(values)
    })
    this.pendingWrite = operation.catch(() => undefined)
    return operation
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Saved connections could not be read. Existing connection data has been preserved.')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw Error('Saved connections could not be read. Existing connection data has been preserved.')
    }
  }

  private async write(values: Record<string, string>) {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(values), { mode: 0o600 })
    await rename(temp, this.file)
  }
}
