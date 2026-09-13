import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDevStderrFilter } from './dev-stderr-filter.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')
const child = spawn(process.execPath, [cli, 'dev'], {
  cwd: root,
  env: {
    ...process.env,
    // A development build must not fight the installed app: Electron's single
    // instance lock is per userData, and the second instance that loses it quits
    // and hands focus back to the installed app. Development keeps its own store
    // so both can run at once. `SHUN_USER_DATA` still wins when set explicitly.
    SHUN_USER_DATA: process.env.SHUN_USER_DATA || join(root, 'tmp', 'dev-user-data'),
  },
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
