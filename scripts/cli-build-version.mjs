import { readFile, writeFile } from 'node:fs/promises'
const version = process.env.SHUN_BUILD_VERSION
if (version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Use a release version such as 0.1.145.')
  const file = new URL('../package.json', import.meta.url)
  const manifest = JSON.parse(await readFile(file, 'utf8'))
  manifest.version = version
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`)
}
