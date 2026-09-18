import assert from 'node:assert/strict'
import test from 'node:test'
import { openInSystemBrowser } from './external-open.ts'

const url = 'https://todo.shunagent.site/'
const ran = (log: Array<string>) => async (command: string, args: string[]) => { log.push([command, ...args].join(' ')) }

test('the platform mechanism is used first, and nothing else runs when it works', async () => {
  const log: string[] = []
  const result = await openInSystemBrowser(url, { platform: 'darwin', openExternal: async () => {}, run: ran(log) })
  assert.deepEqual(result, { opened: true, mechanism: 'system' })
  assert.deepEqual(log, [])
})

test('each platform falls back to its own command, and the result names it', async () => {
  const mac: string[] = []
  assert.deepEqual(await openInSystemBrowser(url, { platform: 'darwin', openExternal: async () => { throw Error('no') }, run: ran(mac) }), { opened: true, mechanism: 'open' })
  assert.deepEqual(mac, [`/usr/bin/open ${url}`])

  // When the system opener accepts nothing, the browser is addressed directly.
  const macBroken: string[] = []
  const macFallback = await openInSystemBrowser(url, {
    platform: 'darwin',
    openExternal: async () => { throw Error('no') },
    run: async (command, args) => { macBroken.push([command, ...args].join(' ')); if (command === '/usr/bin/open') throw Error('unavailable') },
  })
  assert.deepEqual(macFallback, { opened: true, mechanism: 'open-location' })
  assert.deepEqual(macBroken, [`/usr/bin/open ${url}`, `/usr/bin/osascript -e open location "${url}"`])

  const win: string[] = []
  assert.deepEqual(await openInSystemBrowser(url, { platform: 'win32', openExternal: async () => { throw Error('no') }, run: ran(win) }), { opened: true, mechanism: 'start' })
  assert.deepEqual(win, [`cmd.exe /d /s /c start  ${url}`])

  // Linux tries xdg-open, then gio, and says which one worked.
  const linux: string[] = []
  const linuxResult = await openInSystemBrowser(url, {
    platform: 'linux',
    openExternal: async () => { throw Error('no') },
    run: async (command, args) => { linux.push([command, ...args].join(' ')); if (command === 'xdg-open') throw Error('missing') },
  })
  assert.deepEqual(linuxResult, { opened: true, mechanism: 'gio' })
  assert.deepEqual(linux, [`xdg-open ${url}`, `gio open ${url}`])
})

test('a browser that cannot be reached is reported, never invented', async () => {
  const result = await openInSystemBrowser(url, { platform: 'linux', openExternal: async () => { throw Error('no') }, run: async () => { throw Error('xdg-open: not found') } })
  assert.equal(result.opened, false)
  assert.equal(result.mechanism, 'failed')
  assert.match(result.error || '', /not found/)
})
