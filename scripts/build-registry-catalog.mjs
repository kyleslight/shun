#!/usr/bin/env node
/**
 * Build the registry catalog from the packages in `registry/seeds/`.
 *
 *   node --experimental-strip-types scripts/build-registry-catalog.mjs
 *   node --experimental-strip-types scripts/build-registry-catalog.mjs --upload --local
 *   node --experimental-strip-types scripts/build-registry-catalog.mjs --upload
 *
 * `--upload --local` writes into wrangler's local R2 for `pnpm registry:dev`;
 * `--upload` targets the deployed bucket and therefore needs an explicit go-ahead.
 * The generation itself lives in `registry/src/build-catalog.ts`, so the tests
 * exercise the same code the release does.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMarketplaceCatalog } from '../registry/src/build-catalog.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const seedsRoot = join(root, 'registry', 'seeds')
const distRoot = join(root, 'registry', 'dist')
const bucket = 'shun-marketplace'
const args = new Set(process.argv.slice(2))
const upload = args.has('--upload')
const local = args.has('--local')

await rm(distRoot, { recursive: true, force: true })
const { catalog, objects } = await buildMarketplaceCatalog({ seedsRoot })

for (const object of objects) {
  const file = join(distRoot, object.key)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, object.bytes)
}
for (const entry of catalog.entries) {
  const version = entry.versions[0]
  console.log(`packed ${entry.id}@${version.version}  archive ${version.archiveBytes} B  files ${version.files}  sha256 ${version.sha256.slice(0, 12)}…  content ${version.contentSha256.slice(0, 12)}…`)
}
console.log(`catalog: ${catalog.entries.length} entr${catalog.entries.length === 1 ? 'y' : 'ies'} -> registry/dist`)

if (!upload) {
  console.log('\nno upload requested. To publish these bytes:')
  console.log('  pnpm registry:catalog --upload --local   # wrangler local R2, for pnpm registry:dev')
  console.log('  pnpm registry:catalog --upload           # the deployed bucket')
} else {
  console.log(`\nuploading to ${bucket}${local ? ' (local)' : ''} …`)
  for (const object of objects) {
    execFileSync('npx', ['--yes', 'wrangler', 'r2', 'object', 'put', `${bucket}/${object.key}`, '--file', join(distRoot, object.key), ...(local ? ['--local'] : ['--remote'])], { cwd: join(root, 'registry'), stdio: 'inherit' })
  }
  console.log(`uploaded ${objects.length} objects`)
}
