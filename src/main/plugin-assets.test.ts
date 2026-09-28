import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import test from 'node:test'
import type { Settings } from '../shared.ts'
import { PluginPackageRegistry } from './plugin-packages.ts'
import { pluginAssetSource } from './plugin-assets.ts'
import { RemotePreviews, type PreviewAssetSource, type RemotePreviewPush } from './remote-preview.ts'

/**
 * A plugin's own interface reaching a surface, with the files this machine
 * actually has.
 *
 * Every piece of this existed and was tested on its own, and the pieces had
 * never met: a registry that resolves a package, an origin that is not a server,
 * a tunnel that carries a response, and a view that was opened by a token. What
 * is asserted here is the seam — the bytes a phone would receive for the entry
 * its manifest declares, and the refusal it would get for a file that is not
 * part of the package.
 */

/** What a real package looks like on disk: a manifest, an entry, and its assets. */
async function installPackage() {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-assets-'))
  const bundled = join(root, 'bundled'), installed = join(root, 'installed'), source = join(root, 'source')
  await mkdir(bundled)
  await mkdir(join(source, 'ui'), { recursive: true })
  await writeFile(join(source, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'kiko',
    name: 'Kiko',
    description: 'A test package with the shape of a real one.',
    version: '0.1.2',
    publisher: 'Test',
    permissions: [{ id: 'workspace.read', reason: 'Read the dossiers it renders.' }],
    contributes: { views: [{ id: 'kiko.main', title: 'Kiko 档案', location: 'workspace.right', entry: 'ui/index.html' }] },
  }))
  const entry = '<!doctype html><link rel="stylesheet" href="styles.css"><script src="shun-host.js"></script><script src="app.js"></script>'
  await writeFile(join(source, 'ui', 'index.html'), entry)
  await writeFile(join(source, 'ui', 'app.js'), 'window.ShunPlugin?.ready.then(context => { window.__context = context })')
  await writeFile(join(source, 'ui', 'styles.css'), 'main { color: var(--text-1) }')
  const registry = new PluginPackageRegistry(bundled, installed)
  await registry.refresh()
  await registry.installFromDirectory(source)
  return { registry, entry }
}

/**
 * The reader a real build has: the file's own type, which is the runtime's
 * answer rather than a table kept here.
 */
function reader(registry: PluginPackageRegistry) {
  const types: Record<string, string> = { html: 'text/html', js: 'text/javascript', css: 'text/css' }
  const asked: string[] = []
  const read = async (path: string) => {
    asked.push(path)
    const body = await readFile(path).catch(() => undefined)
    if (!body) return undefined
    const extension = path.split('.').pop() || ''
    return { contentType: types[extension] || 'application/octet-stream', body }
  }
  return { asked, source: pluginAssetSource((pluginId, path) => registry.assetPath(pluginId, path), read) }
}

function collector() {
  const pushes: Push[] = []
  return { pushes, previews: (source: PreviewAssetSource) => new RemotePreviews((linkId, event) => pushes.push({ linkId, ...event }), [source]) }
}

type Push = RemotePreviewPush & { linkId: string }
const ended = (push: Push, streamId: number) =>
  push.streamId === streamId && (push.type === 'preview.end' || ((push.type === 'preview.response' || push.type === 'preview.data') && push.end === true))

/** Wait for the stream to finish, then hand back what a caller would have read. */
async function body(pushes: Push[], streamId: number) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !pushes.some(push => ended(push, streamId))) await new Promise(resolve => setTimeout(resolve, 5))
  const head = pushes.find((push): push is Push & { type: 'preview.response' } => push.streamId === streamId && push.type === 'preview.response')
  const chunks: Buffer[] = []
  for (const push of pushes) {
    if (push.streamId !== streamId) continue
    if (push.type === 'preview.response' && push.data) chunks.push(Buffer.from(push.data, 'base64url'))
    else if (push.type === 'preview.data') chunks.push(Buffer.from(push.data, 'base64url'))
  }
  return { head, body: Buffer.concat(chunks).toString('utf8'), ended: pushes.some(push => ended(push, streamId)) }
}

test('the entry a manifest declares is served to whoever opened that view', async () => {
  const { registry, entry } = await installPackage()
  const settings: Settings = { plugins: [{ id: 'kiko', enabled: true, permissions: ['workspace.read'] }] } as Settings
  const view = registry.openView(settings, 'kiko', 'kiko.main', '/workspace-a', 'task-a')
  const read = reader(registry)
  const { pushes, previews } = collector()

  const instances = previews(read.source)
  const opened = instances.open({ linkId: 'link-1', taskId: 'task-a', url: `shun-plugin://${view.pluginId}/`, authority: '127.0.0.1:51234' })
  // Exactly what a phone asks for: the manifest's entry, under the origin of the
  // package, carrying the channel its own bridge reads.
  instances.send({ sessionId: opened.sessionId, streamId: 1, url: '/ui/index.html?channel=abc', headers: {} })

  const served = await body(pushes, 1)
  assert.equal(served.head?.status, 200)
  assert.equal(served.head?.headers['content-type'], 'text/html')
  assert.equal(served.body, entry)
  // The channel is a query and a query is not part of a file's name.
  assert.match(read.asked[0], /ui[/\\]index\.html$/)
  // A package is data on disk that reloads in place, so what it serves is asked
  // for again rather than held.
  assert.equal(served.head?.headers['cache-control'], 'no-cache')
  assert.ok(String(served.head?.headers.etag).startsWith('"'))
})

test('the assets the entry references come from the same package', async () => {
  const { registry } = await installPackage()
  const settings: Settings = { plugins: [{ id: 'kiko', enabled: true, permissions: ['workspace.read'] }] } as Settings
  const read = reader(registry)
  const { pushes, previews } = collector()
  const instances = previews(read.source)
  const opened = instances.open({ linkId: 'link-1', taskId: 'task-a', url: 'shun-plugin://kiko/', authority: '127.0.0.1:51234' })

  instances.send({ sessionId: opened.sessionId, streamId: 1, url: '/ui/app.js', headers: {} })
  instances.send({ sessionId: opened.sessionId, streamId: 2, url: '/ui/styles.css', headers: {} })

  assert.match((await body(pushes, 1)).body, /ShunPlugin/)
  assert.equal((await body(pushes, 1)).head?.headers['content-type'], 'text/javascript')
  assert.match((await body(pushes, 2)).body, /--text-1/)
  assert.equal((await body(pushes, 2)).head?.headers['content-type'], 'text/css')
  void registry
})

test('a file outside the package is refused rather than read', async () => {
  const { registry } = await installPackage()
  const { pushes, previews } = collector()
  const instances = previews(reader(registry).source)
  const opened = instances.open({ linkId: 'link-1', taskId: 'task-a', url: 'shun-plugin://kiko/', authority: '127.0.0.1:51234' })

  instances.send({ sessionId: opened.sessionId, streamId: 1, url: '/../../../etc/passwd', headers: {} })
  const deadline = Date.now() + 2_000
  const served = await body(pushes, 1)
  // A refusal here is an answer: the caller is a browser, and the frame this
  // arrived on cannot deliver an exception — a request refused by throwing is a
  // request the page waits on forever.
  assert.equal(served.head?.status, 403)
  assert.ok(served.ended)
})

/**
 * A package's files are the same bytes until the package changes, and a caller
 * that already has them says which ones it has.
 *
 * Answering that is the difference between reopening an interface and
 * downloading everything it is made of — which, over a link, is seconds rather
 * than nothing. It is also the reason the files carry a validator at all.
 */
test('a file already held is not sent again', async () => {
  const { registry } = await installPackage()
  const { pushes, previews } = collector()
  const instances = previews(reader(registry).source)
  const opened = instances.open({ linkId: 'link-1', taskId: 'task-a', url: 'shun-plugin://kiko/', authority: '127.0.0.1:51234' })

  instances.send({ sessionId: opened.sessionId, streamId: 1, url: '/ui/app.js', headers: {} })
  const first = await body(pushes, 1)
  const etag = String(first.head?.headers.etag)
  assert.ok(etag.startsWith('"'))

  instances.send({ sessionId: opened.sessionId, streamId: 2, url: '/ui/app.js', headers: { 'if-none-match': etag } })
  const second = await body(pushes, 2)
  assert.equal(second.head?.status, 304)
  assert.equal(second.body, '', 'a revalidation carries no bytes')
  assert.equal(second.head?.headers.etag, etag)
})
