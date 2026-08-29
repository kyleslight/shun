import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

type StoredWorkspaceState = Record<string, Record<string, unknown>>

const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const maximumValueBytes = 64 * 1024
const maximumKeysPerWorkspace = 200

export class PluginWorkspaceStateStore {
  private readonly file: string
  #loaded?: Promise<StoredWorkspaceState>
  #writeQueue = Promise.resolve()

  constructor(file: string) { this.file = file }

  async get(pluginId: string, workspace: string, key: string) {
    validateIdentity(pluginId, key)
    const state = await this.#state()
    return state[await namespace(pluginId, workspace)]?.[key]
  }

  async set(pluginId: string, workspace: string, key: string, value: unknown) {
    validateIdentity(pluginId, key)
    validateValue(value)
    const state = await this.#state()
    const id = await namespace(pluginId, workspace)
    const values = state[id] || {}
    if (!(key in values) && Object.keys(values).length >= maximumKeysPerWorkspace) throw Error('Plugin workspace state has reached its key limit.')
    values[key] = cloneJson(value)
    state[id] = values
    await this.#persist(state)
    return cloneJson(values[key])
  }

  async #state() {
    this.#loaded ||= readFile(this.file, 'utf8').then(text => {
      const value = JSON.parse(text)
      return value && typeof value === 'object' && !Array.isArray(value) ? value as StoredWorkspaceState : {}
    }, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    })
    return this.#loaded
  }

  async #persist(state: StoredWorkspaceState) {
    const text = JSON.stringify(state)
    this.#writeQueue = this.#writeQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const staging = `${this.file}.${process.pid}.tmp`
      await writeFile(staging, text, { encoding: 'utf8', mode: 0o600 })
      await rename(staging, this.file)
    })
    await this.#writeQueue
  }
}

async function namespace(pluginId: string, workspace: string) {
  if (!String(workspace || '').trim()) throw Error('Plugin workspace state requires a selected workspace.')
  const root = await realpath(resolve(workspace))
  const digest = createHash('sha256').update(root).digest('hex')
  return `${pluginId}:${digest}`
}

function validateIdentity(pluginId: string, key: string) {
  if (!pluginIdPattern.test(pluginId)) throw Error('Invalid plugin id.')
  if (!keyPattern.test(key)) throw Error('Plugin workspace state key must be 1-100 letters, numbers, dots, underscores, or hyphens.')
}

function validateValue(value: unknown) {
  if (value === undefined) throw Error('Plugin workspace state value is required.')
  let text = ''
  try { text = JSON.stringify(value) } catch { throw Error('Plugin workspace state value must be JSON-serializable.') }
  if (text === undefined) throw Error('Plugin workspace state value must be JSON-serializable.')
  if (Buffer.byteLength(text, 'utf8') > maximumValueBytes) throw Error('Plugin workspace state value exceeds 64 KB.')
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
