import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pluginViewFrameSource } from '../renderer/src/plugin-view-url.ts'

const renderer = join(import.meta.dirname, '..', 'renderer', 'src')
const host = await readFile(join(renderer, 'plugin-view-host.tsx'), 'utf8')

/**
 * The address of a view's interface is asked for on every render of the panel,
 * and two of the states it can be asked in carry no address at all: a view of the
 * other machine before its files arrive, and any view whose descriptor travelled
 * over a link. Reading those as a URL threw, and a throw in the middle of a render
 * is not an error the person can see — it is a window that keeps its old picture
 * while every click after it does nothing.
 */
test('a view without an address has no source, rather than an exception', () => {
  assert.equal(pluginViewFrameSource(undefined, undefined, 'channel-1'), '')
  assert.equal(pluginViewFrameSource('', '', 'channel-1'), '')
  assert.equal(pluginViewFrameSource(undefined, '   ', 'channel-1'), '')
})

test('an address that cannot be read is the same empty answer', () => {
  assert.equal(pluginViewFrameSource(undefined, 'not a url', 'channel-1'), '')
  assert.equal(pluginViewFrameSource('shun plugin:/ui/index.html', undefined, 'channel-1'), '')
})

test('this machine serves its own views over its own scheme, and that is an address', () => {
  const source = pluginViewFrameSource(undefined, 'shun-plugin://kiko/ui/index.html?instance=abc', 'channel-1')
  const url = new URL(source)
  assert.equal(url.protocol, 'shun-plugin:')
  assert.equal(url.hostname, 'kiko')
  assert.equal(url.pathname, '/ui/index.html')
  assert.equal(url.searchParams.get('instance'), 'abc')
})

test('the window adds its own channel and host version to whatever it loads', () => {
  for (const source of [
    pluginViewFrameSource('http://127.0.0.1:51234/ui/index.html?instance=abc', undefined, 'channel-2'),
    pluginViewFrameSource(undefined, 'https://127.0.0.1:51234/ui/index.html', 'channel-2'),
  ]) {
    const url = new URL(source)
    assert.equal(url.searchParams.get('channel'), 'channel-2')
    assert.equal(url.searchParams.get('host'), '2')
  }
})

/**
 * The panel is drawn from the address it has, never from which machine supplied
 * it: a local view carries no tunnel address, and keying the frame on the tunnel
 * left every view of this machine's own plugins saying "Opening…" over files that
 * had already arrived.
 */
test('the frame is drawn from the address, and its absence is the opening state', () => {
  assert.match(host, /import \{ pluginViewFrameSource \} from '\.\/plugin-view-url'/)
  assert.match(host, /source = useMemo\(\(\) => pluginViewFrameSource\(frameUrl, view\.url, channel\), \[frameUrl, view\.url, channel\]\)/)
  assert.doesNotMatch(host, /new URL\(frameUrl/, 'the address is read in one place, and that place is total')
  assert.match(host, /\{source\n\s+\? <iframe/)
  assert.match(host, /: <div class="plugin-view-loading"/)
  assert.match(host, /permissions = Array\.isArray\(view\.permissions\) \? view\.permissions : \[\]/)
  assert.match(host, /canFullscreen = view\.location === 'workspace\.full' \|\| permissions\.includes\('workspace\.fullscreen'\)/)
})
