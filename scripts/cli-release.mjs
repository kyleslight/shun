import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const cliTargets = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']
export function stageCliRelease(source, destination, version, repositoryRoot) {
  const verified = []
  for (const target of cliTargets) {
    const name = `shun-cli-${target}.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`
    const archive = join(source, name), checksum = `${archive}.sha256`
    const expected = readFileSync(checksum, 'utf8').trim().split(/\s+/)
    if (expected.length !== 2 || expected[1] !== name || !/^[a-f0-9]{64}$/.test(expected[0])) throw Error(`Invalid CLI checksum: ${name}`)
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== expected[0]) throw Error(`CLI checksum mismatch: ${name}`)
    const builtVersion = target.startsWith('win32')
      ? execFileSync('unzip', ['-p', archive, 'shun/VERSION'], { encoding: 'utf8' }).trim()
      : execFileSync('tar', ['-xOf', archive, 'shun/VERSION'], { encoding: 'utf8' }).trim()
    if (builtVersion !== version) throw Error(`${name} is version ${builtVersion}; the release is ${version}. Rebuild every CLI artifact for this release.`)
    verified.push({ name, archive, checksum })
  }
  mkdirSync(destination, { recursive: true })
  for (const item of verified) {
    copyFileSync(item.archive, join(destination, item.name))
    copyFileSync(item.checksum, join(destination, `${item.name}.sha256`))
  }
  for (const name of ['install.sh', 'install.ps1']) copyFileSync(join(repositoryRoot, 'scripts', name), join(destination, name))
}
