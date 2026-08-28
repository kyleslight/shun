import { spawn } from 'node:child_process'
import electron from 'electron'

const child = spawn(electron, ['--experimental-strip-types', 'scripts/web-read-live-smoke.mjs'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
child.stderr.on('data', chunk => { process.stderr.write(chunk) })
child.once('error', error => {
  console.error(error)
  process.exitCode = 1
})
child.once('close', code => {
  process.exitCode = code === 0 && output.includes('SHUN_WEB_SMOKE_RESULT=pass') ? 0 : 1
})
