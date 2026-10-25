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
  plugins: [{
    name: 'shun-optional-capabilities',
    transform(code, id) {
      if (!id.includes('/src/')) return
      let changed = false
      const result = code.replace(/import\((['"])(pdfjs-dist\/legacy\/build\/pdf\.mjs|@napi-rs\/canvas|puppeteer-core(?:\/internal\/revisions\.js)?|@puppeteer\/browsers)\1\)/g, (_all, _quote, name) => { changed = true; return `loadCapabilityModule(${JSON.stringify(name)})` })
      if (changed) return { code: `import { loadCapabilityModule } from ${JSON.stringify(resolve(root, 'src/cli/capability-modules.ts'))};\n${result}`, map: null }
    },
  }],
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
