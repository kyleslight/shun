import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { createTrayHost, hidesToTrayOnClose, trayIconPath, trayLabels, trayLanguageFromState, trayMenu, trayUsesChinese, type TrayHandle, type TrayIcon, type TrayMenuItem, type TrayOptions } from './windows-tray.ts'

test('the Windows tray menu offers the window, settings, and a full quit', () => {
  const english = trayMenu(false)
  assert.deepEqual(english.map(entry => entry.type === 'separator' ? 'separator' : entry.command), ['show', 'settings', 'separator', 'quit'])
  assert.deepEqual((trayMenu(false)[0] as { label: string }).label, 'Open Shun')
  assert.deepEqual(trayMenu(true).map(entry => entry.type === 'separator' ? 'separator' : entry.command), ['show', 'settings', 'separator', 'quit'])
  assert.deepEqual((trayMenu(true)[3] as { label: string }).label, '退出 Shun')
  assert.match(trayLabels(true).tooltip, /Shun/)
  assert.ok(trayLabels(true).backgroundNotice.content.length > 0)
  assert.ok(trayLabels(false).backgroundNotice.content.length > 0)
})

test('tray labels follow the selected interface language and the system locale', () => {
  assert.equal(trayUsesChinese('zh-CN', 'en-US'), true)
  assert.equal(trayUsesChinese('en', 'zh-CN'), false)
  assert.equal(trayUsesChinese('system', 'zh-Hans-CN'), true)
  assert.equal(trayUsesChinese('system', 'en-GB'), false)
  assert.equal(trayUsesChinese(undefined, 'zh-CN'), true)
  assert.equal(trayLanguageFromState({ settings: { language: 'zh-CN' } }), 'zh-CN')
  assert.equal(trayLanguageFromState({ settings: {} }), undefined)
  assert.equal(trayLanguageFromState(null), undefined)
  assert.equal(trayLanguageFromState('zh-CN'), undefined)
})

test('closing the Windows window hides into the tray instead of ending the session', () => {
  assert.equal(hidesToTrayOnClose('win32', false, true), true)
  assert.equal(hidesToTrayOnClose('win32', true, true), false, 'an explicit quit must close the window')
  assert.equal(hidesToTrayOnClose('win32', false, false), false, 'without a tray the app must stay reachable')
  assert.equal(hidesToTrayOnClose('darwin', false, true), false)
  assert.equal(hidesToTrayOnClose('linux', false, true), false)
  assert.equal(trayIconPath('app').endsWith(join('resources', 'tray-icon.png')), true)
})

// The tray is the only way back into a hidden Windows window, so its wiring is
// exercised here through injected adapters instead of only on a Windows box.
function trayHarness(overrides: Partial<TrayOptions> = {}) {
  const shown: string[] = []
  const balloons: Array<{ title: string; content: string }> = []
  const tooltips: string[] = []
  const menus: TrayMenuItem[][] = []
  const openers: Array<() => void> = []
  const logs: string[] = []
  const iconPaths: string[] = []
  let tray: TrayHandle | undefined

  const host = createTrayHost({
    platform: 'win32',
    locale: () => 'en-US',
    iconPath: trayIconPath('/app'),
    loadIcon: (path): TrayIcon => { iconPaths.push(path); return { isEmpty: () => false } },
    createTray: (): TrayHandle => {
      tray = {
        setToolTip: tooltip => { tooltips.push(tooltip) },
        setContextMenu: menu => { menus.push(menu as TrayMenuItem[]) },
        onDoubleClick: listener => { openers.push(listener) },
        displayBalloon: notice => { balloons.push(notice) },
      }
      return tray
    },
    createMenu: items => items,
    show: () => { shown.push('show') },
    openSettings: () => { shown.push('settings') },
    quit: () => { shown.push('quit') },
    log: message => { logs.push(message) },
    ...overrides,
  })
  const run = (index: number) => {
    const item = menus.at(-1)?.[index]
    assert.equal(item?.type, 'command')
    ;(item as { run: () => void }).run()
  }
  return { host, run, shown, balloons, tooltips, menus, openers, logs, iconPaths, tray: () => tray }
}

test('the host wires the Windows tray to the window, settings, and a real quit', () => {
  const harness = trayHarness()
  assert.equal(harness.host.install('en'), true)
  assert.deepEqual(harness.iconPaths, [join('/app', 'resources', 'tray-icon.png')])
  assert.deepEqual(harness.tooltips, ['Shun — running in background'])
  assert.deepEqual(harness.menus.at(-1)?.map(item => item.type === 'separator' ? 'separator' : item.label), ['Open Shun', 'Settings…', 'separator', 'Quit Shun'])
  assert.equal(harness.openers.length, 1)

  harness.run(0)
  assert.deepEqual(harness.shown, ['show'])
  harness.run(1)
  assert.deepEqual(harness.shown, ['show', 'show', 'settings'])
  harness.run(3)
  assert.deepEqual(harness.shown, ['show', 'show', 'settings', 'quit'], 'quitting must not reopen the window first')
  harness.openers[0]()
  assert.deepEqual(harness.shown.at(-1), 'show')
})

test('the host stays out of the way on macOS and Linux', () => {
  for (const platform of ['darwin', 'linux']) {
    const harness = trayHarness({ platform })
    assert.equal(harness.host.install('en'), false)
    assert.equal(harness.tray(), undefined)
    assert.equal(harness.menus.length, 0)
    assert.equal(harness.host.hidesOnClose(false), false)
  }
})

test('a missing tray icon keeps the plain close behavior and is reported', () => {
  const harness = trayHarness({ loadIcon: (): TrayIcon => ({ isEmpty: () => true }) })
  assert.equal(harness.host.install('en'), false)
  assert.equal(harness.tray(), undefined)
  assert.match(harness.logs.join('\n'), /Unable to load the tray icon/)
  assert.equal(harness.host.hidesOnClose(false), false, 'an invisible tray must never hide the only window')
})

test('the tray hides the window only while Shun is running on Windows', () => {
  const harness = trayHarness()
  assert.equal(harness.host.hidesOnClose(false), false, 'no tray yet, so closing must keep working')
  harness.host.install('en')
  assert.equal(harness.host.hidesOnClose(false), true)
  assert.equal(harness.host.hidesOnClose(true), false, 'an explicit quit has to close the window')
  harness.host.notifyBackground()
})

test('the tray follows a language change and explains itself once per session', () => {
  const harness = trayHarness()
  harness.host.install('en')
  harness.host.refresh('en')
  assert.equal(harness.menus.length, 1, 'an unchanged language must not rebuild the menu')
  harness.host.notifyBackground()
  harness.host.notifyBackground()
  assert.equal(harness.balloons.length, 1)
  assert.equal(harness.balloons[0].title, 'Shun is still running')

  harness.host.refresh('zh-CN')
  assert.equal(harness.tooltips.at(-1), 'Shun — 后台运行中')
  assert.deepEqual(harness.menus.at(-1)?.map(item => item.type === 'separator' ? 'separator' : item.label), ['显示主界面', '设置…', 'separator', '退出 Shun'])
  harness.host.notifyBackground()
  assert.equal(harness.balloons.length, 1, 'the hint stays once per session')

  const systemChinese = trayHarness({ locale: () => 'zh-Hans-CN' })
  systemChinese.host.install('system')
  assert.equal(systemChinese.tooltips.at(-1), 'Shun — 后台运行中')
})
