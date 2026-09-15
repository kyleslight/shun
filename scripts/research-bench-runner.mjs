/**
 * Run the research benchmark inside Electron so it can use the hidden Chromium
 * the product renders research pages through.
 *
 *   pnpm bench:research:app -- --count 20 --concurrency 4
 *
 * The harness itself is unchanged: it detects Electron and takes the renderer from
 * `src/main/web-render.ts`, which is the same module the application uses.
 */
import { spawn } from 'node:child_process'
import electron from 'electron'

const child = spawn(electron, ['--experimental-strip-types', 'scripts/research-bench.mjs', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => process.stdout.write(chunk))
child.stderr.on('data', chunk => process.stderr.write(chunk))
child.once('error', error => { console.error(error); process.exitCode = 1 })
child.once('close', code => { process.exitCode = code ?? 1 })
