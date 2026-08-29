import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevStderrFilter } from './dev-stderr-filter.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, 'dev'], {
  cwd: root,
  env: process.env,
  stdio: ['inherit', 'inherit', 'pipe'],
})

child.stderr.pipe(createDevStderrFilter()).pipe(process.stderr)
child.on('error', error => {
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
