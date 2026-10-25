import { build } from 'vite'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const manifestPath = resolve(root, 'packages/shun/package.json')
const manifest = JSON.parse(await readFile(resolve(root, 'packages/shun/package.template.json'), 'utf8'))
// The release version has one source of truth, shared by every install channel.
manifest.version = desktop.version
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
await build({
  configFile: false, root,
  define: { SHUN_CLI_VERSION: JSON.stringify(desktop.version) },
  build: {
    ssr: resolve(root, 'src/cli/index.ts'), target: 'node22', outDir: resolve(root, 'packages/shun/dist'), emptyOutDir: true,
    minify: false,
    rollupOptions: {
      external: id => Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).some(name => id === name || id.startsWith(`${name}/`)),
      output: { entryFileNames: 'cli.js' },
    },
  },
})
await chmod(resolve(root, 'packages/shun/bin/shun.mjs'), 0o755)
