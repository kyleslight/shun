import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { hostPaths } from '../host/paths.ts'

const modules = {
  'pdfjs-dist/legacy/build/pdf.mjs': { group: 'pdf', packages: ['pdfjs-dist@6.2.108'] },
  '@napi-rs/canvas': { group: 'images', packages: ['@napi-rs/canvas@1.0.6'] },
  'puppeteer-core': { group: 'browser', packages: ['puppeteer-core@25.16.0', '@puppeteer/browsers@3.2.6'] },
  'puppeteer-core/internal/revisions.js': { group: 'browser', packages: ['puppeteer-core@25.16.0', '@puppeteer/browsers@3.2.6'] },
  '@puppeteer/browsers': { group: 'browser', packages: ['puppeteer-core@25.16.0', '@puppeteer/browsers@3.2.6'] },
} as const
export type CapabilityModule = keyof typeof modules
const pending = new Map<string, Promise<string>>()
async function installPackages(directory: string, packages: readonly string[]) {
  const bundled = join(dirname(process.execPath), 'npm', 'bin', 'npm-cli.js')
  const candidates = [bundled, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    ...(process.platform === 'win32' ? (process.env.PATH || '').split(delimiter).filter(Boolean).map(path => join(path, 'node_modules/npm/bin/npm-cli.js')) : [])]
  let npmCli: string | undefined
  for (const candidate of candidates) if (await access(candidate).then(() => true).catch(() => false)) { npmCli = candidate; break }
  if (process.platform === 'win32' && !npmCli) throw Error('Install Node.js with npm to enable this optional capability.')
  const args = ['install', '--prefix', directory, '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', ...packages]
  await new Promise<void>((resolve, reject) => {
    const executable = npmCli ? process.execPath : 'npm'
    const commandArgs = npmCli ? [npmCli, ...args] : args
    const child = spawn(executable, commandArgs, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 180_000, windowsHide: true })
    let error = ''
    child.stderr.on('data', chunk => { error = (error + chunk.toString()).slice(-2000) })
    child.once('error', () => reject(Error('Could not install this optional capability. Install Node.js with npm and try again.')))
    child.once('exit', code => code === 0 ? resolve() : reject(Error(`Optional capability installation failed. Retry when npm can reach the registry. ${error.replace(/https?:\/\/\S+/g, '[registry]')}`)))
  })
}
export async function capabilityDirectory(specifier: CapabilityModule, root = join(hostPaths().root, 'capabilities'), install = installPackages): Promise<string> {
  const spec = modules[specifier]
  if (!spec) throw Error('Unknown optional capability.')
  const key = `${spec.group}-${spec.packages.join('-').replace(/[^a-zA-Z0-9.-]/g, '_')}`
  const directory = join(root, key), marker = join(directory, '.ready')
  if (await access(marker).then(() => true).catch(() => false)) return directory
  let work = pending.get(directory)
  if (!work) {
    work = (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      const temporary = await mkdtemp(join(root, '.install-'))
      try {
        await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, name: `shun-${spec.group}-capability`, version: '1.0.0' }))
        await install(temporary, spec.packages)
        await writeFile(join(temporary, '.ready'), 'ready\n')
        try { await rename(temporary, directory) }
        catch (error) { if (!await access(marker).then(() => true).catch(() => false)) throw error }
        return directory
      } finally { await rm(temporary, { recursive: true, force: true }) }
    })().finally(() => pending.delete(directory))
    pending.set(directory, work)
  }
  return work
}
export async function loadCapabilityModule(specifier: CapabilityModule): Promise<any> {
  const directory = await capabilityDirectory(specifier)
  const require = createRequire(join(directory, 'package.json'))
  return import(pathToFileURL(require.resolve(specifier)).href)
}
