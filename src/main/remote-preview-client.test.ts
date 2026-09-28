import { strict as assert } from 'node:assert'
import { request as httpRequest } from 'node:http'
import test from 'node:test'
import { PREVIEW_FRAME_BYTES } from './remote-preview.ts'
import { RemotePreviewClient, previewAssetPath, previewRequestHeaders, revalidatingKey } from './remote-preview-client.ts'

type Assets = Record<string, { body: string; contentType?: string; etag?: string }>

/**
 * The other end, as this one talks to it.
 *
 * It answers `preview.open` with a session per open, and answers each request by
 * pushing the frames the serving end pushes — so what is under test is the half
 * that has to turn frames into a page a surface can load.
 */
function servingEnd(assets: Assets) {
  const frames: Array<{ kind: string; payload: Record<string, unknown> }> = []
  let client: RemotePreviewClient
  let sessions = 0
  const send = async (desktopId: string, kind: string, payload: Record<string, unknown>) => {
    frames.push({ kind, payload })
    if (kind === 'preview.open') return { sessionId: `peer-session-${++sessions}`, url: String(payload.url) }
    if (kind === 'preview.close') return { closed: true }
    if (kind !== 'preview.send') return {}
    const sessionId = String(payload.sessionId), streamId = Number(payload.streamId), path = String(payload.url).split('?')[0]
    const asset = assets[path]
    const validator = (payload.headers as Record<string, string> | undefined)?.['if-none-match']
    queueMicrotask(() => {
      if (!asset) {
        client.handle({ desktopId, sessionId, streamId, type: 'preview.response', status: 404, statusText: 'Not Found', headers: {}, end: true })
        return
      }
      const etag = `"${asset.etag || 'v1'}"`
      // A file the caller already holds is answered with the fact and no bytes:
      // that 304 is the whole reason opening a view a second time is cheap.
      if (validator === etag) {
        client.handle({ desktopId, sessionId, streamId, type: 'preview.response', status: 304, statusText: 'Not Modified', headers: { etag, 'cache-control': 'no-cache' }, end: true })
        return
      }
      client.handle({
        desktopId, sessionId, streamId, type: 'preview.response', status: 200, statusText: 'OK',
        headers: { 'content-type': asset.contentType || 'text/html', etag, 'cache-control': 'no-cache' },
        data: Buffer.from(asset.body).toString('base64url'), end: true,
      })
    })
    return { accepted: true, streamId }
  }
  return { frames, send, attach: (instance: RemotePreviewClient) => { client = instance } }
}

type Opened = { client: RemotePreviewClient; peer: ReturnType<typeof servingEnd>; handle: { sessionId: string; origin: string } }

/** One open view, and nothing left listening once the test that opened it is done. */
function withView(assets: Assets, run: (context: Opened) => Promise<void>) {
  return async (t: { after: (fn: () => void) => void }) => {
    const peer = servingEnd(assets)
    const client = new RemotePreviewClient({ send: peer.send })
    peer.attach(client)
    const handle = await client.open({ desktopId: 'desk-1', taskId: 'task-1', url: 'shun-plugin://git-workbench/', key: 'p-git-workbench-main' })
    t.after(() => client.dispose())
    await run({ client, peer, handle })
  }
}

test('a view opens at an origin of this machine, and its files are carried by the link', withView(
  { '/index.html': { body: '<!doctype html><title>Git</title>' } },
  async ({ client: _client, peer, handle }) => {
    assert.match(handle.origin, /^http:\/\/127\.0\.0\.1:\d+\/p-git-workbench-main$/)
    const open = peer.frames.find(frame => frame.kind === 'preview.open')
    assert.equal(open?.payload.url, 'shun-plugin://git-workbench/')
    assert.equal(open?.payload.taskId, 'task-1')
    // The serving end is told which authority to answer as: without it the page
    // it serves is addressed to a machine the surface is not loading from.
    assert.match(String(open?.payload.authority), /^127\.0\.0\.1:\d+$/)

    const response = await fetch(`${handle.origin}/index.html`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/html')
    assert.equal(await response.text(), '<!doctype html><title>Git</title>')
    const request = peer.frames.find(frame => frame.kind === 'preview.send')
    assert.equal(request?.payload.url, '/index.html')
    assert.equal(request?.payload.method, 'GET')
  },
))

test('a file this end already holds is revalidated, and answering it costs no body', withView(
  { '/app.js': { body: 'export const v = 1', contentType: 'text/javascript', etag: 'abc' } },
  async ({ peer, handle }) => {
    assert.equal(await (await fetch(`${handle.origin}/app.js`)).text(), 'export const v = 1')
    const response = await fetch(`${handle.origin}/app.js`, { headers: { 'if-none-match': '"abc"' } })
    assert.equal(await response.text(), 'export const v = 1')
    const sends = peer.frames.filter(frame => frame.kind === 'preview.send')
    // Two questions and one transfer: the second carried a validator and came
    // back as a fact, and the copy this end held is what answered the caller.
    assert.equal(sends.length, 2)
    assert.equal((sends[1].payload.headers as Record<string, string>)['if-none-match'], '"abc"')
  },
))

test('a view reopened under the same name is served from what is already held', withView(
  { '/index.html': { body: '<html>same</html>', etag: 'v1' } },
  async ({ peer, handle }) => {
    // The channel a view is mounted with is new on every open, and a channel is
    // not part of a file's name — so the copy is held under the file.
    assert.equal(revalidatingKey('/index.html?channel=one&host=2'), '/index.html')
    assert.equal(await (await fetch(`${handle.origin}/index.html?channel=one&host=2`)).text(), '<html>same</html>')
    assert.equal(await (await fetch(`${handle.origin}/index.html?channel=two&host=2`)).text(), '<html>same</html>')
    const sends = peer.frames.filter(frame => frame.kind === 'preview.send')
    assert.equal((sends[1].payload.headers as Record<string, string>)['if-none-match'], '"v1"')
  },
))

test('what a package change invalidates is dropped, so the next read is the file again', withView(
  { '/index.html': { body: 'first', etag: 'v1' } },
  async ({ client, peer, handle }) => {
    assert.equal(await (await fetch(`${handle.origin}/index.html`)).text(), 'first')
    client.handle({ desktopId: 'desk-1', sessionId: 'peer-session-1', type: 'preview.invalidate', all: true })
    assert.equal(await (await fetch(`${handle.origin}/index.html`)).text(), 'first')
    // The dropped copy is asked for again rather than answered from a validator
    // that may no longer describe it.
    const sends = peer.frames.filter(frame => frame.kind === 'preview.send')
    assert.equal((sends[1].payload.headers as Record<string, string>)['if-none-match'], undefined)
  },
))

test('a path that escapes this view is refused here and never forwarded', withView(
  {},
  async ({ peer, handle }) => {
    const port = Number(new URL(handle.origin).port)
    assert.equal(await rawStatus(port, '/p-git-workbench-main/../../etc/passwd'), 403)
    assert.equal(peer.frames.filter(frame => frame.kind === 'preview.send').length, 0)
    // A package may address its own files from the root of the origin it loads in
    // — that is how it addresses them where it is installed — so a root path is
    // this view's own file and not another view's.
    assert.equal(await rawStatus(port, '/assets/app.js'), 404)
    assert.equal(peer.frames.filter(frame => frame.kind === 'preview.send').length, 1)
  },
))

/** One request whose path is sent exactly as written, which a browser would normalize. */
function rawStatus(port: number, path: string) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, response => { response.resume(); resolve(response.statusCode || 0) })
    request.on('error', reject)
    request.end()
  })
}

test('closing a preview tells the other end, which stops answering that origin', withView(
  {},
  async ({ client, handle, peer }) => {
    assert.equal(await client.close(handle.sessionId), true)
    assert.deepEqual(client.list(), [])
    assert.equal(peer.frames.some(frame => frame.kind === 'preview.close'), true)
    // Nothing is left listening under the name it was opened at.
    await assert.rejects(() => fetch(`${handle.origin}/index.html`))
  },
))

test('one machine may hold only as many previews as the other end will answer', withView(
  { '/index.html': { body: 'x' } },
  async ({ client }) => {
    for (let index = 1; index < 4; index++) await client.open({ desktopId: 'desk-1', taskId: 'task-1', url: 'shun-plugin://git-workbench/', key: `p-view-${index}` })
    await assert.rejects(
      () => client.open({ desktopId: 'desk-1', taskId: 'task-1', url: 'shun-plugin://git-workbench/', key: 'p-view-5' }),
      /At most 4 previews/,
    )
    // Another machine's budget is its own.
    const other = await client.open({ desktopId: 'desk-2', taskId: 'task-2', url: 'shun-plugin://git-workbench/', key: 'p-view-1' })
    assert.ok(other.origin)
    assert.equal(client.closeDesktop('desk-1'), true)
    assert.deepEqual(client.list().map(session => session.desktopId), ['desk-2'])
  },
))

test('a request body larger than one frame is sent as more of the same request', withView(
  { '/index.html': { body: 'ok' } },
  async ({ peer, handle }) => {
    const body = 'x'.repeat(PREVIEW_FRAME_BYTES + 5)
    const answered = await fetch(`${handle.origin}/index.html`, { method: 'POST', body })
    assert.equal(await answered.text(), 'ok')
    const sent = peer.frames.find(frame => frame.kind === 'preview.send')
    const rest = peer.frames.filter(frame => frame.kind === 'preview.body')
    // The link counts frames, so a body that does not fit is carried as more of
    // the same request rather than as one frame the link would refuse.
    assert.equal(sent?.payload.more, true)
    assert.equal(Buffer.from(String(sent?.payload.body), 'base64url').length, PREVIEW_FRAME_BYTES)
    assert.equal(rest.length, 1)
    assert.equal(Buffer.from(String(rest[0].payload.data), 'base64url').length, 5)
    assert.equal(rest[0].payload.more, false)
  },
))

test('a path belongs to the one view that was opened, and a name is what makes a copy reusable', () => {
  assert.equal(previewAssetPath('/p-view/index.html', 'p-view'), '/index.html')
  assert.equal(previewAssetPath('/p-view/app/main.js?x=1', 'p-view'), '/app/main.js?x=1')
  assert.equal(previewAssetPath('/p-view', 'p-view'), '/')
  assert.equal(previewAssetPath('/p-view//other/index.html', 'p-view'), undefined)
  // A package may address its own files from the root of the origin it loads in.
  // This origin is one view's, so its root is that view — and the other end still
  // reads only the package the view was opened for.
  assert.equal(previewAssetPath('/assets/app.js', 'p-view'), '/assets/app.js')
  assert.equal(previewAssetPath('/p-view/../../etc/passwd', 'p-view'), undefined)
  assert.equal(previewAssetPath('/assets/../../etc/passwd', 'p-view'), undefined)
  assert.equal(revalidatingKey('/index.html?channel=a&host=2'), '/index.html')
  assert.equal(revalidatingKey('/app.js?v=2&channel=a'), '/app.js?v=2')
  // What decides the bytes travels; what decides nothing about them does not.
  assert.deepEqual(previewRequestHeaders({ accept: 'text/html', range: 'bytes=0-10' }), { accept: 'text/html' })
  assert.deepEqual(previewRequestHeaders({ 'if-none-match': '"ours"' }, '"held"'), { 'if-none-match': '"held"' })
})
