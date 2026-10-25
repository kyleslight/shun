import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { cliTargets, stageCliRelease } from './cli-release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
test('standalone installer works without npm, quotes custom paths, and refuses a corrupt download', { skip: process.platform === 'win32' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'shun-install-test-'))
  try {
    const source = join(temporary, 'source'), mocks = join(temporary, 'mocks'), destination = join(temporary, "Shun's folder $literal"), bin = join(temporary, 'bin')
    await mkdir(join(source, 'shun'), { recursive: true }); await mkdir(mocks)
    await writeFile(join(source, 'shun/VERSION'), '0.1.145\n')
    await writeFile(join(source, 'shun/shun'), '#!/bin/sh\nprintf "Shun fixture %s\\n" "$*"\n', { mode: 0o755 })
    const archive = join(temporary, 'archive.tar.gz')
    execFileSync('tar', ['-czf', archive, 'shun'], { cwd: source })
    const digest = createHash('sha256').update(await readFile(archive)).digest('hex')
    await writeFile(join(mocks, 'curl'), '#!/bin/sh\nfor arg in "$@"; do case "$arg" in https:*) url=$arg ;; esac; done\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; output=$1; fi; shift; done\ncase "$url" in *.sha256) name=${url##*/}; printf "%s  %s\\n" "$FIXTURE_DIGEST" "${name%.sha256}" > "$output" ;; *) cp "$FIXTURE_ARCHIVE" "$output" ;; esac\n', { mode: 0o755 })
    const env = { ...process.env, HOME: join(temporary, 'home'), SHELL: '/bin/zsh', ZDOTDIR: join(temporary, 'home'), PATH: `${mocks}:/usr/bin:/bin`, SHUN_INSTALL_DIR: destination, SHUN_BIN_DIR: bin, FIXTURE_DIGEST: digest, FIXTURE_ARCHIVE: archive }
    const result = spawnSync('sh', [join(root, 'scripts/install.sh')], { env, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(execFileSync(join(bin, 'shun'), ['--version'], { encoding: 'utf8' }), /Shun fixture --version/)
    assert.equal(execFileSync('sh', ['-c', '. "$HOME/.zshrc"; command -v shun'], { env, encoding: 'utf8' }).trim(), join(bin, 'shun'))
    const installedAgain = spawnSync('sh', [join(root, 'scripts/install.sh')], { env, encoding: 'utf8' })
    assert.equal(installedAgain.status, 0, installedAgain.stderr)
    assert.equal((await readFile(join(env.HOME, '.zshrc'), 'utf8')).split('# Shun CLI').length, 2)
    const launcher = await readFile(join(bin, 'shun'), 'utf8')
    const rejected = spawnSync('sh', [join(root, 'scripts/install.sh')], { env: { ...env, FIXTURE_DIGEST: '0'.repeat(64) }, encoding: 'utf8' })
    assert.notEqual(rejected.status, 0)
    assert.match(rejected.stderr, /verification failed/)
    assert.equal(await readFile(join(bin, 'shun'), 'utf8'), launcher)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('CLI manifest excludes the desktop shell and uses one public executable', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'packages/shun/package.template.json'), 'utf8'))
  assert.equal(manifest.name, '@shunagent/shun')
  assert.deepEqual(manifest.bin, { shun: 'bin/shun.mjs' })
  assert.equal(manifest.dependencies.electron, undefined)
  assert.equal(manifest.dependencies['electron-updater'], undefined)
})

test('release staging requires every platform at the same version with matching checksums', { skip: process.platform === 'win32' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'shun-cli-release-'))
  try {
    const source = join(temporary, 'source'), content = join(temporary, 'content'), destination = join(temporary, 'staged')
    await mkdir(source); await mkdir(join(content, 'shun'), { recursive: true })
    await writeFile(join(content, 'shun/VERSION'), '0.1.145\n')
    for (const target of cliTargets) {
      const name = `shun-cli-${target}.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`, path = join(source, name)
      if (target.startsWith('win32')) await writeFile(path, zipSync({ 'shun/VERSION': strToU8('0.1.145\n') }))
      else execFileSync('tar', ['-czf', path, 'shun'], { cwd: content })
      const digest = createHash('sha256').update(await readFile(path)).digest('hex')
      await writeFile(`${path}.sha256`, `${digest}  ${name}\n`)
    }
    assert.throws(() => stageCliRelease(source, destination, '0.1.146', root), /Rebuild every CLI artifact/)
    stageCliRelease(source, destination, '0.1.145', root)
    assert.equal(await readFile(join(destination, 'install.sh'), 'utf8'), await readFile(join(root, 'scripts/install.sh'), 'utf8'))
    await writeFile(join(source, 'shun-cli-linux-x64.tar.gz'), 'corrupted')
    assert.throws(() => stageCliRelease(source, destination, '0.1.145', root), /checksum mismatch/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
