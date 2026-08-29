import { chmod, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('node-pty/package.json'))
  await makeHelpersExecutable(root)
}

async function makeHelpersExecutable(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await makeHelpersExecutable(path)
    else if (entry.name === 'spawn-helper') await chmod(path, 0o755)
  }
}
