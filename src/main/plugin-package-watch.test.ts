import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginPackageWatch, pluginPackageChanges, pluginPackageSignatures } from './plugin-package-watch.ts'

async function packageRoot(name: string, version = '1.0.0', extra = '') {
  const root = await mkdtemp(join(tmpdir(), `shun-${name}-`))
  await mkdir(join(root, 'demo', 'ui'), { recursive: true })
  await writeFile(join(root, 'demo', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', version }))
  await writeFile(join(root, 'demo', 'ui', 'app.js'), `console.log('v1')${extra}`)
  return root
}

/** mtime resolution is coarse on some filesystems, so change it explicitly. */
async function touch(path: string, seconds: number) {
  const when = new Date(Date.now() + seconds * 1_000)
  await utimes(path, when, when)
}

test('a package signature tracks the manifest and the contents, not only the version', async () => {
  const root = await packageRoot('signature')
  try {
    const first = await pluginPackageSignatures([root])
    assert.deepEqual([...first.keys()], ['demo'])

    // An edit in place — the ordinary development case — must count as a change.
    await writeFile(join(root, 'demo', 'ui', 'app.js'), "console.log('v2')")
    await touch(join(root, 'demo', 'ui', 'app.js'), 2)
    const edited = await pluginPackageSignatures([root])
    assert.notEqual(edited.get('demo'), first.get('demo'))
    assert.deepEqual(pluginPackageChanges(first, edited), { added: [], changed: ['demo'], removed: [] })

    // A directory without a usable manifest is not a package.
    await mkdir(join(root, 'notes'), { recursive: true })
    await writeFile(join(root, 'notes', 'readme.md'), 'not a package')
    assert.deepEqual([...(await pluginPackageSignatures([root])).keys()], ['demo'])

    await rm(join(root, 'demo'), { recursive: true })
    const removed = await pluginPackageSignatures([root])
    assert.deepEqual(pluginPackageChanges(edited, removed), { added: [], changed: [], removed: ['demo'] })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the watcher notices a package changing while the app runs, and stays quiet when stopped', async () => {
  const root = await packageRoot('watch')
  let notifications = 0
  let release: (() => void) | undefined
  const watch = new PluginPackageWatch({
    roots: [root],
    delayMs: 30,
    settle: () => { notifications++; release?.(); release = undefined },
  })
  const waitForSettle = () => new Promise<void>(resolve => {
    release = resolve
    setTimeout(() => { if (release === resolve) { release = undefined; resolve() } }, 3_000)
  })
  try {
    watch.start()
    await writeFile(join(root, 'demo', 'ui', 'app.js'), "console.log('v2')")
    await waitForSettle()
    assert.ok(notifications >= 1, 'a package edit must be reported without a restart')

    // A single write may produce several filesystem events, which is legitimate:
    // what matters is that a stopped watcher stops reporting, not how many times a
    // live one coalesced the same edit.
    watch.stop()
    await new Promise(resolve => setTimeout(resolve, 500))
    const stopped = notifications
    await writeFile(join(root, 'demo', 'ui', 'app.js'), "console.log('v3')")
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(notifications, stopped, 'a stopped watcher must stay quiet')
  } finally {
    watch.stop()
    await rm(root, { recursive: true, force: true })
  }
})

test('the application announces what the watcher notices, and never defaults that decision away', async () => {
  const main = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  // Chosen explicitly at both call sites: startup has nothing to announce yet, and
  // the watcher always must. A defaulted flag here once meant the watcher returned
  // before broadcasting, so hot reload logged nothing and changed nothing.
  assert.match(main, /settle: \(\) => \{ void refreshPluginPackages\(\{ announce: true \}\)/)
  assert.match(main, /await refreshPluginPackages\(\{ announce: false \}\)/)
  assert.doesNotMatch(main, /refreshPluginPackages\(options: \{ announce\?: boolean \}/)
  // The watch has to be running, or nothing above is ever reached at runtime.
  assert.match(main, /await refreshPluginPackages\(\{ announce: false \}\)[\s\S]{0,120}pluginPackageWatch\.start\(\)/)
})
