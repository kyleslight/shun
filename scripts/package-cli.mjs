import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'packages/shun/package.json'), 'utf8'))
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
if (manifest.version !== version) throw Error('Build the CLI before packaging so versions match.')
const supported = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
const target = `${process.platform}-${process.arch}`
if (!supported.has(target)) throw Error(`CLI packaging is not configured for ${target}.`)
const nodeVersion = '22.23.1'
const output = resolve(process.env.SHUN_CLI_OUTPUT || join(root, 'release-cli'))
const temporary = await mkdtemp(join(tmpdir(), 'shun-package-'))
const run = (file, args, cwd = temporary) => execFileSync(file, args, { cwd, stdio: 'inherit', env: process.env })
try {
  await mkdir(output, { recursive: true })
  const bundle = join(temporary, 'shun')
  await mkdir(bundle)
  await cp(join(root, 'packages/shun'), join(bundle, 'app'), { recursive: true, filter: source => !source.split(/[\\/]/).includes('node_modules') })
  if (process.platform === 'win32') run('cmd.exe', ['/d', '/s', '/c', 'npm install --registry=https://registry.npmjs.org --omit=dev --no-audit --no-fund'], join(bundle, 'app'))
  else run('npm', ['install', '--registry=https://registry.npmjs.org', '--omit=dev', '--no-audit', '--no-fund'], join(bundle, 'app'))
  const nodePlatform = process.platform === 'win32' ? 'win' : process.platform
  const archive = `node-v${nodeVersion}-${nodePlatform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
  const base = `https://nodejs.org/dist/v${nodeVersion}`
  const download = async name => {
    const response = await fetch(`${base}/${name}`, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw Error(`Could not download the standalone runtime (${response.status}).`)
    return Buffer.from(await response.arrayBuffer())
  }
  const checksums = (await download('SHASUMS256.txt')).toString('utf8')
  const expected = checksums.split('\n').find(line => line.trim().split(/\s+/).at(-1) === archive)?.split(/\s+/)[0]
  if (!expected) throw Error('Standalone runtime checksum is missing.')
  const bytes = await download(archive)
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('Standalone runtime checksum mismatch.')
  await writeFile(join(temporary, archive), bytes)
  const extracted = join(temporary, `node-v${nodeVersion}-${nodePlatform}-${process.arch}`)
  if (process.platform === 'win32') run('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${join(temporary, archive).replace(/'/g, "''")}' -DestinationPath '${temporary.replace(/'/g, "''")}'`])
  else run('tar', ['-xzf', archive])
  await mkdir(join(bundle, 'runtime'))
  await cp(join(extracted, process.platform === 'win32' ? 'node.exe' : 'bin/node'), join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'))
  await cp(join(extracted, 'LICENSE'), join(bundle, 'runtime', 'LICENSE'))
  await cp(join(extracted, process.platform === 'win32' ? 'node_modules/npm' : 'lib/node_modules/npm'), join(bundle, 'runtime', 'npm'), { recursive: true })
  await writeFile(join(bundle, 'VERSION'), version + '\n')
  await writeFile(join(bundle, 'shun'), '#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$root/runtime/node" "$root/app/bin/shun.mjs" "$@"\n', { mode: 0o755 })
  await writeFile(join(bundle, 'shun.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0app\\bin\\shun.mjs" %*\r\n')
  run(join(bundle, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'), [join(bundle, 'app/bin/shun.mjs'), '--version'])
  const filename = `shun-cli-${target}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
  const path = join(output, filename)
  if (process.platform === 'win32') run('powershell.exe', ['-NoProfile', '-Command', `Compress-Archive -Path '${bundle.replace(/'/g, "''")}' -DestinationPath '${path.replace(/'/g, "''")}' -Force`])
  else run('tar', ['-czf', path, 'shun'])
  const checksum = createHash('sha256').update(await readFile(path)).digest('hex')
  await writeFile(`${path}.sha256`, `${checksum}  ${filename}\n`)
  console.log(`Created ${filename} (${version})`)
} finally { await rm(temporary, { recursive: true, force: true }) }
