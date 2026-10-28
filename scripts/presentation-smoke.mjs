import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [require.resolve('vite')] }))
const temporary = await mkdtemp(join(tmpdir(), 'shun-presentation-runner-'))
try {
  const output = join(temporary, 'presentation-smoke.cjs')
  await build({ entryPoints: [fileURLToPath(new URL('./presentation-smoke.ts', import.meta.url))], outfile: output, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [output], { env, stdio: 'inherit' })
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) }) }
  finally { clearTimeout(timer) }
} finally { await rm(temporary, { recursive: true, force: true }) }
