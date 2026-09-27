import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import test, { type TestContext } from 'node:test'
import { WebSocketServer } from 'ws'
import { PREVIEW_FRAME_BYTES, RemotePreviews, liveReloadInvalidation, previewAuthority, previewOrigin, serverFrames, type RemotePreviewPush } from './remote-preview.ts'

type Push = RemotePreviewPush & { linkId: string }

/** A dev server stand-in: an http page, a slow stream, and a live-reload websocket. */
async function devServer(t: TestContext) {
  const sockets: Array<{ send(data: string): void }> = []
  const seen: Array<{ url: string; host: string | undefined; validator?: string }> = []
  const open = new Set<import('node:net').Socket>()
  const server = createServer((req, res) => {
    seen.push({ url: req.url || '', host: req.headers.host, validator: req.headers['if-none-match'] as string | undefined })
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(300 * 1024) })
      res.end(Buffer.alloc(300 * 1024, 0x61))
      return
    }
    if (req.url === '/cached') {
      // What a dev server actually does: no-cache plus an ETag, which means a
      // browser may keep it and must ask again — and the answer is 304.
      const body = 'export const value = 1\n'
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"', 'cache-control': 'no-cache' }); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/javascript', etag: '"v1"', 'cache-control': 'no-cache' })
      res.end(body)
      return
    }
    if (req.url === '/echo') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Buffer.concat(chunks)) })
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<script type="module" src="/main.js"></script>')
  })
  const wss = new WebSocketServer({ server, path: '/hmr' })
  wss.on('connection', socket => {
    sockets.push({ send: data => socket.send(data) })
    socket.on('message', data => socket.send(`echo:${data.toString()}`))
  })
  server.on('connection', socket => { open.add(socket); socket.on('close', () => open.delete(socket)) })
  // Registered before anything can fail, so a failing assertion still tears the
  // server down instead of leaving the whole file waiting on it.
  t.after(() => { for (const socket of open) socket.destroy(); wss.close(); server.close() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    origin: `http://127.0.0.1:${port}/`,
    wsOrigin: `ws://127.0.0.1:${port}/hmr`,
    seen,
    liveReload: (data: string) => { for (const socket of sockets) socket.send(data) },
    // Sockets are torn down explicitly: a server that stops listening still
    // holds its upgraded connections, and a test that leaves them open hangs
    // the run rather than failing it.
    close: () => { for (const socket of open) socket.destroy(); wss.close(); server.close() },
  }
}

/**
 * A client-to-server websocket text frame, masked as the protocol requires.
 * The tunnel carries bytes and never interprets them, so a frame is what has to
 * be sent — raw text is not a websocket message, and a server is right to
 * reject it.
 */
function maskedTextFrame(text: string) {
  const payload = Buffer.from(text, 'utf8')
  const mask = Buffer.from([0x37, 0xfa, 0x21, 0x3d])
  const head = payload.length < 126
    ? Buffer.from([0x81, 0x80 | payload.length])
    : Buffer.concat([Buffer.from([0x81, 0x80 | 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])])
  const masked = Buffer.from(payload)
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4]
  return Buffer.concat([head, mask, masked])
}

/** Body bytes arrive on whichever frame carried them: the head can carry the first. */
function bodyOf(pushes: Push[]) {
  const chunks: Buffer[] = []
  for (const push of pushes) {
    if (push.type === 'preview.response') { if (push.data) chunks.push(Buffer.from(push.data, 'base64url')) }
    else if (push.type === 'preview.data') chunks.push(Buffer.from(push.data, 'base64url'))
  }
  return Buffer.concat(chunks)
}

/** Only the frames a caller reads a response out of; invalidation is not one. */
function responseFrames(pushes: Push[]) {
  return pushes.filter(push => push.type !== 'preview.invalidate')
}

const isEnd = (push: Push) => push.type === 'preview.end' || ((push.type === 'preview.response' || push.type === 'preview.data') && push.end === true)

function collector() {
  const pushes: Push[] = []
  const previews = new RemotePreviews((linkId, event) => pushes.push({ linkId, ...event } as Push))
  return {
    pushes,
    previews,
    /** Wait for the first push matching a predicate, so a test never sleeps on a guess. */
    async until(predicate: (push: Push) => boolean, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = pushes.find(predicate)
        if (found) return found
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      throw Error(`No push matched. Saw: ${JSON.stringify(pushes)}`)
    },
    forStream: (sessionId: string, streamId: number) => pushes.filter(push => push.sessionId === sessionId && push.streamId === streamId),
  }
}

/**
 * The whole feature rests on this: a caller reaches the dev server this task
 * started and nothing else on the machine. A tunnel that forwards to whatever
 * host it is asked for is a way to reach every service on somebody's computer,
 * including the ones that trust a loopback address.
 */
test('a preview reaches a loopback origin and refuses everything else', () => {
  for (const allowed of ['http://localhost:5173/', 'http://127.0.0.1:3000/app', 'https://127.0.0.1:5173/']) {
    assert.equal(typeof previewOrigin(allowed), 'string', allowed)
  }
  for (const refused of [
    'http://example.com/', 'http://192.168.1.20:5173/', 'http://10.0.0.5/', 'https://relay.shunagent.com/',
    'file:///etc/passwd', 'ftp://127.0.0.1/', 'http://user:pass@127.0.0.1:5173/', 'not a url', '',
  ]) assert.equal(previewOrigin(refused), undefined, refused)
  // The port and path a session was opened on are part of the origin it is pinned to.
  assert.equal(previewOrigin('http://127.0.0.1:5173/app?x=1'), 'http://127.0.0.1:5173/')
})

/** The Host this side forges is the caller's own view of itself, so it is checked the same way. */
test('the forged authority is the caller loopback address and nothing else', () => {
  assert.equal(previewAuthority('127.0.0.1:51234'), '127.0.0.1:51234')
  assert.equal(previewAuthority('localhost:8080'), 'localhost:8080')
  for (const refused of ['example.com', '127.0.0.1:51234/../evil', 'user@127.0.0.1:1', '192.168.1.5:80', '']) {
    assert.equal(previewAuthority(refused), undefined, refused)
  }
})

test('a page comes back over the link, with the caller authority on the request', async t => {
  const dev = await devServer(t), { previews, pushes, until } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  previews.send({ sessionId, streamId: 1, method: 'GET', url: '/', headers: { accept: 'text/html' } })

  const head = await until(push => push.type === 'preview.response')
  assert.equal(head.type === 'preview.response' && head.status, 200)
  await until(isEnd)
  assert.match(bodyOf(pushes).toString(), /<script type="module" src="\/main\.js">/)
  // A dev server hands its client the address it was asked on, so the caller's
  // own authority is what has to arrive — that is what live reload dials later.
  assert.equal(dev.seen[0].url, '/')
  assert.equal(dev.seen[0].host, '127.0.0.1:51234')
  assert.equal(pushes[0].linkId, 'link-1')
})

/**
 * A page is a frame per resource, and the link is metered in frames as much as
 * in bytes, so a response that fits answers in exactly one: its head, its body,
 * and the fact that it is complete, together. Anything else is a page paying
 * two extra frames per resource for nothing.
 */
test('a small response is exactly one frame, carrying its head, body, and completion', async t => {
  const dev = await devServer(t), { previews, pushes, until } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  previews.send({ sessionId, streamId: 1, method: 'GET', url: '/', headers: {} })
  await until(isEnd)
  const frames = responseFrames(pushes)
  assert.equal(frames.length, 1)
  assert.equal(frames[0].type, 'preview.response')
  assert.equal(frames[0].type === 'preview.response' && frames[0].end, true)
  assert.match(bodyOf(pushes).toString(), /<script/)
})

test('a request body is carried and answered', async t => {
  const dev = await devServer(t), { previews, pushes, until } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  previews.send({ sessionId, streamId: 1, method: 'POST', url: '/echo', headers: {}, body: Buffer.from('hello').toString('base64url') })
  await until(isEnd)
  assert.equal(bodyOf(pushes).toString(), 'hello')
})

/** A response larger than one frame is split, so no single frame can outgrow the link. */
test('a large response is cut into frames that fit', async t => {
  const dev = await devServer(t), { previews, pushes, until } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  previews.send({ sessionId, streamId: 1, method: 'GET', url: '/big', headers: {} })
  await until(isEnd)
  assert.equal(bodyOf(pushes).length, 300 * 1024)
  assert.ok(pushes.length >= 3, `expected several frames, saw ${pushes.length}`)
  for (const push of responseFrames(pushes)) {
    const raw = push.type === 'preview.end' ? 0 : Buffer.from(push.data || '', 'base64url').length
    assert.ok(raw <= PREVIEW_FRAME_BYTES, `${raw} exceeds the frame size`)
  }
  // Completion rides the last frame rather than costing one of its own.
  assert.equal(pushes.filter(isEnd).length, 1)
})

/**
 * Live reload is a websocket, and without it a preview becomes "edit and
 * refresh". The upgrade has to survive the link, and both directions stay raw
 * afterwards.
 */
test('a websocket upgrade survives the link and stays open both ways', async t => {
  const dev = await devServer(t), { previews, until, forStream } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  previews.send({ sessionId, streamId: 7, method: 'GET', url: '/hmr', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', 'sec-websocket-protocol': 'vite-hmr' } })

  const head = await until(push => push.type === 'preview.response' && push.status === 101)
  assert.equal(head.type === 'preview.response' && head.status, 101)
  assert.ok(head.type === 'preview.response' && String(head.headers.upgrade).toLowerCase() === 'websocket')

  // The dev server pushes a message the caller never asked for, and the caller
  // receives what was said rather than the frames that carried it.
  dev.liveReload('{"type":"update","path":"/style.css"}')
  const inbound = await until(push => push.type === 'preview.message')
  assert.match(Buffer.from(inbound.type === 'preview.message' ? inbound.data : '', 'base64url').toString(), /style\.css/)

  // And the other direction is a message too: this end frames it.
  previews.message({ sessionId, streamId: 7, data: Buffer.from('ping').toString('base64url') })
  await until(push => push.type === 'preview.message' && push.data === Buffer.from('echo:ping').toString('base64url'))
  // A websocket never ends on its own: it ends when its link does.
  assert.equal(forStream(sessionId, 7).filter(isEnd).length, 0)
  // It is a socket, not a request body: sending a body is a mistake worth naming.
  assert.throws(() => previews.body({ sessionId, streamId: 7, data: Buffer.from('x').toString('base64url'), more: false }), /socket; send a message/)
})

test('a preview does not outlive the link that opened it', async t => {
  const dev = await devServer(t), { previews, until } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  previews.closeLink('link-1')
  assert.throws(() => previews.send({ sessionId, streamId: 1, method: 'GET', url: '/', headers: {} }), /no longer open/)
  // Another link's session is untouched: a preview answers the controller that asked.
  const other = previews.open({ linkId: 'link-2', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51235' })
  previews.send({ sessionId: other.sessionId, streamId: 1, method: 'GET', url: '/', headers: {} })
  await until(push => push.linkId === 'link-2' && isEnd(push))
})

/**
 * A caller names a path; anything that could name another host is not a path.
 *
 * And it is refused with an answer rather than an exception, because the caller
 * is a browser waiting on a response and the frame the request arrived on is
 * fire-and-forget: a request refused by throwing is one the page waits on
 * forever.
 */
test('a request cannot name a host or a protocol of its own', async t => {
  const dev = await devServer(t), { previews, pushes, until } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  const refused = ['http://example.com/', '//example.com/', 'https://127.0.0.1:80/x', '', '/../../etc/passwd']
  for (const [index, url] of refused.entries()) {
    const streamId = index + 1
    previews.send({ sessionId, streamId, method: 'GET', url, headers: {} })
    const head = await until(push => push.streamId === streamId && push.type === 'preview.response')
    assert.ok(head.type === 'preview.response' && head.status >= 400, url)
    await until(push => push.streamId === streamId && isEnd(push))
  }
  // One frame each: the same single-frame answer a small response gets, because
  // a refusal is a response and not a special case of one.
  assert.equal(pushes.length, refused.length)
  assert.equal(dev.seen.length, 0, 'nothing was dialled')
})

test('opening the same origin twice reuses the session, and the limit holds', async t => {
  const dev = await devServer(t), { previews } = collector()
  const first = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  const again = previews.open({ linkId: 'link-1', taskId: 'task-1', url: `${dev.origin}some/other/path`, authority: '127.0.0.1:51234' })
  assert.equal(again.sessionId, first.sessionId)
  assert.throws(() => previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: 'example.com' }), /loopback/)
})

/** What is refused has to be refused before anything is dialled. */
test('a refused origin never reaches the network', () => {
  const { previews } = collector()
  for (const url of ['http://example.com/', 'file:///etc/passwd', 'http://169.254.169.254/latest/meta-data/']) {
    assert.throws(() => previews.open({ linkId: 'link-1', taskId: 'task-1', url, authority: '127.0.0.1:1' }), /on this machine/)
  }
})

/**
 * The link is a credential, and a credential that can ask for any loopback
 * address turns a phone into a way to read every service the user happens to be
 * running. What a controller may preview is therefore the page the task itself
 * started, and the check lives where the request arrives rather than only in
 * this module, because this module cannot see what a task started.
 */
test('a remote preview is gated on a server the task itself started', async () => {
  const index = await readFile(new URL('index.ts', import.meta.url), 'utf8')
  assert.match(index, /frame\.kind === 'preview\.open'[\s\S]*backgroundTasks\.listAll\(\)\.filter\(item => item\.sessionId === taskId\)\.flatMap\(item => item\.endpoints\)\.map\(previewOrigin\)[\s\S]*if \(!started\.includes\(url\)\) throw Error\('This preview is not a server this task started/)
  assert.match(index, /onLinkClosed: linkId => \{ remoteTerminals\?\.closeLink\(linkId\); remotePreviews\?\.closeLink\(linkId\) \}/)
})

/**
 * A dev server answers with `no-cache` and an ETag, which is the one thing that
 * makes a remote preview affordable: it means the browser keeps every resource
 * and asks again rather than downloading again. Measured against a real Vite
 * server, the second load of a page is 0 bytes for every resource it already
 * holds — so the whole cost of a session is its first load, and what a link
 * carries afterwards is a revalidation, not a page.
 *
 * It only works if the validators survive the trip in both directions, which is
 * why this is a test and not an assumption.
 */
test('a revalidation travels both ways, so a reload costs no bytes', async t => {
  const dev = await devServer(t), { previews, pushes, until } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })

  previews.send({ sessionId, streamId: 1, method: 'GET', url: '/cached', headers: {} })
  const first = await until(push => push.type === 'preview.response')
  assert.equal(first.type === 'preview.response' && first.status, 200)
  const etag = first.type === 'preview.response' ? String(first.headers.etag) : ''
  assert.equal(etag, '"v1"')
  await until(push => push.streamId === 1 && isEnd(push))

  pushes.length = 0
  previews.send({ sessionId, streamId: 2, method: 'GET', url: '/cached', headers: { 'if-none-match': etag } })
  const second = await until(push => push.streamId === 2 && push.type === 'preview.response')
  assert.equal(second.type === 'preview.response' && second.status, 304)
  await until(push => push.streamId === 2 && isEnd(push))
  // One frame back, carrying no body, and the server saw the validator.
  assert.equal(second.type === 'preview.response' && second.data, undefined)
  assert.equal(bodyOf(pushes).length, 0)
  assert.equal(dev.seen.at(-1)?.validator, etag)
})

/** A live-reload message, read the way the other end would read it. */
test('a change signal names what moved, and an unreadable one names nothing', () => {
  assert.deepEqual(liveReloadInvalidation(JSON.stringify({ type: 'update', updates: [{ type: 'js-update', path: '/src/main.js', acceptedPath: '/src/main.js' }] })), { paths: ['/src/main.js'] })
  assert.deepEqual(liveReloadInvalidation(JSON.stringify({ type: 'update', updates: [{ path: '/a.css' }, { acceptedPath: '/b.css' }] })), { paths: ['/a.css', '/b.css'] })
  assert.deepEqual(liveReloadInvalidation(JSON.stringify({ type: 'full-reload' })), { all: true })
  // Nothing that did not name a change may drop a cache: the transfer that
  // would cost is the one this mechanism exists to avoid.
  for (const text of ['not json', '{}', JSON.stringify({ type: 'connected' }), JSON.stringify({ type: 'update', updates: [] }), JSON.stringify({ type: 'update', updates: [{ path: 'relative.css' }] })]) {
    assert.equal(liveReloadInvalidation(text), undefined, text)
  }
})

/** Frames are read off the wire, including a message split across chunks. */
test('server frames are read whole, across chunks and fragments', () => {
  const frame = (text: string) => { const body = Buffer.from(text, 'utf8'); return Buffer.concat([Buffer.from([0x81, body.length]), body]) }
  const texts = (messages: ReturnType<ReturnType<typeof serverFrames>>) => messages.map(message => message.data.toString('utf8'))
  const read = serverFrames()
  assert.deepEqual(texts(read(frame('{"type":"connected"}'))), ['{"type":"connected"}'])
  // Split mid-message: nothing is reported until the frame is complete.
  assert.deepEqual(read(frame('{"type":"connected"}').subarray(0, 5)), [])
  assert.deepEqual(texts(read(frame('{"type":"connected"}').subarray(5))), ['{"type":"connected"}'])
  // Two frames in one chunk are two messages, not one.
  assert.deepEqual(texts(read(Buffer.concat([frame('a'), frame('b')]))), ['a', 'b'])
  // A masked payload is not a server frame; it must not be guessed at.
  assert.deepEqual(read(Buffer.from([0x81, 0x81, 1, 2, 3, 4, 0x61])), [])
  // A fragmented message is one message, and binary is not text.
  const split = Buffer.concat([Buffer.from([0x01, 2]), Buffer.from('ab'), Buffer.from([0x80, 2]), Buffer.from('cd')])
  assert.deepEqual(texts(read(split)), ['abcd'])
  assert.equal(read(Buffer.concat([Buffer.from([0x82, 2]), Buffer.from('ab')]))[0].binary, true)
  // A close frame ends the stream rather than being shown as a message.
  assert.equal(read(Buffer.concat([Buffer.from([0x88, 0x02]), Buffer.from([0x03, 0xe8])]))[0].close, true)
})

/**
 * The whole reason a preview is affordable: after the first load, what crosses
 * the link is a change, not a page. That only holds if the change reaches the
 * other end — so the socket the dev server reloads through is also read here.
 */
test('a live-reload message becomes an invalidation for the other end', async t => {
  const dev = await devServer(t), { previews, pushes, until } = collector()
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: dev.origin, authority: '127.0.0.1:51234' })
  previews.send({ sessionId, streamId: 9, method: 'GET', url: '/hmr', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-protocol': 'vite-hmr', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } })
  await until(push => push.type === 'preview.response' && push.status === 101)

  dev.liveReload(JSON.stringify({ type: 'update', updates: [{ type: 'js-update', path: '/src/style.css', acceptedPath: '/src/style.css' }] }))
  const invalidated = await until(push => push.type === 'preview.invalidate')
  assert.deepEqual(invalidated.type === 'preview.invalidate' && invalidated.paths, ['/src/style.css'])

  dev.liveReload(JSON.stringify({ type: 'full-reload', path: '*' }))
  const all = await until(push => push.type === 'preview.invalidate' && push.all === true)
  assert.equal(all.type === 'preview.invalidate' && all.all, true)

  // A socket nobody identified as a dev server is carried and never read.
  previews.send({ sessionId, streamId: 10, method: 'GET', url: '/hmr', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } })
  await until(push => push.streamId === 10 && push.type === 'preview.response')
  dev.liveReload(JSON.stringify({ type: 'full-reload' }))
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(pushes.filter(push => push.streamId === 10 && push.type === 'preview.invalidate').length, 0)
})

/**
 * A plugin's interface is files in a package, and a package is not a server —
 * but a web view can only load an http origin. So a package is served as one,
 * by the tunnel that already knows how to carry a response, which is the same
 * reason a page is.
 */
test('an origin that is not a server is answered from where its bytes are', async () => {
  const files = new Map([
    ['shun-plugin://kiko/ui/index.html', { contentType: 'text/html', body: Buffer.from('<script src="app.js"></script>') }],
  ])
  const pushes: Push[] = []
  const previews = new RemotePreviews(
    (linkId, event) => pushes.push({ linkId, ...event } as Push),
    // The path arrives with the query a plugin's own bridge reads, and the
    // tunnel must not have eaten it on the way.
    [{ matches: origin => origin.startsWith('shun-plugin://'), read: async (origin, path) => files.get(`${origin.replace(/\/$/, '')}${path.replace(/\?.*$/, '')}`) }],
  )
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: 'shun-plugin://kiko/', authority: '127.0.0.1:51234' })
  previews.send({ sessionId, streamId: 1, url: '/ui/index.html?channel=abc', headers: {} })

  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !pushes.some(push => push.type === 'preview.response')) await new Promise(resolve => setTimeout(resolve, 5))
  const head = pushes.find(push => push.type === 'preview.response')
  assert.equal(head?.type === 'preview.response' && head.status, 200)
  assert.match(head?.type === 'preview.response' ? String(head.headers['content-type']) : '', /text\/html/)
  assert.match(bodyOf(pushes).toString(), /app\.js/)
  // A package is data on disk that reloads in place, so what it serves is asked
  // for again rather than held.
  assert.equal(head?.type === 'preview.response' && head.headers['cache-control'], 'no-cache')
  assert.ok(head?.type === 'preview.response' && String(head.headers.etag).startsWith('"'))
})

test('a file the package does not have is a 404, and a source that fails is a 500', async () => {
  const pushes: Push[] = []
  const previews = new RemotePreviews(
    (linkId, event) => pushes.push({ linkId, ...event } as Push),
    [{
      matches: origin => origin.startsWith('shun-plugin://'),
      read: async (_origin, path) => {
        if (path === '/boom') throw Error('unreadable')
        return undefined
      },
    }],
  )
  const { sessionId } = previews.open({ linkId: 'link-1', taskId: 'task-1', url: 'shun-plugin://kiko/', authority: '127.0.0.1:51234' })

  previews.send({ sessionId, streamId: 1, url: '/ui/missing.js', headers: {} })
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !pushes.some(push => push.sessionId === sessionId && push.streamId === 1 && push.type === 'preview.response')) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(pushes.find(push => push.streamId === 1 && push.type === 'preview.response')?.type === 'preview.response'
    ? (pushes.find(push => push.streamId === 1 && push.type === 'preview.response') as { status: number }).status : 0, 404)

  previews.send({ sessionId, streamId: 2, url: '/boom', headers: {} })
  const failing = Date.now() + 2_000
  while (Date.now() < failing && !pushes.some(push => push.streamId === 2 && push.type === 'preview.response')) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal((pushes.find(push => push.streamId === 2 && push.type === 'preview.response') as { status: number }).status, 500)
  // Either way the caller is told the response ended, so a page never waits.
  assert.equal(pushes.filter(push => isEnd(push) && (push.streamId === 1 || push.streamId === 2)).length, 2)
})
