import { join } from 'node:path'

// Shun keeps running after its Windows window is closed, so the tray is the
// only way back to the UI. The model and the host are plain data plus injected
// adapters, so the whole contract is exercised on every platform instead of
// only on Windows; index.ts owns the Electron Tray, Menu, and window calls.
export type TrayCommand = 'show' | 'settings' | 'quit'
export type TrayEntry = { type: 'command'; command: TrayCommand; label: string } | { type: 'separator' }
export type TrayLabels = { tooltip: string; backgroundNotice: { title: string; content: string } }

export type TrayMenuItem = { type: 'command'; label: string; run: () => void } | { type: 'separator' }
export type TrayIcon = { isEmpty(): boolean }
export type TrayHandle = {
  setToolTip(tooltip: string): void
  setContextMenu(menu: unknown): void
  onDoubleClick(listener: () => void): void
  displayBalloon(notice: { title: string; content: string }): void
}

export type TrayOptions = {
  platform: string
  locale: () => string
  iconPath: string
  loadIcon: (path: string) => TrayIcon
  createTray: (icon: TrayIcon) => TrayHandle
  createMenu: (items: TrayMenuItem[]) => unknown
  show: () => void
  openSettings: () => void
  quit: () => void
  log?: (message: string) => void
}

export function trayUsesChinese(language: string | undefined, systemLocale: string) {
  const selected = !language || language === 'system' ? systemLocale : language
  return /^zh/i.test(selected)
}

export function trayLabels(chinese: boolean): TrayLabels {
  return chinese
    ? {
        tooltip: 'Shun — 后台运行中',
        backgroundNotice: {
          title: 'Shun 仍在后台运行',
          content: '任务和后台程序不会中断。用托盘图标可以重新打开主界面、打开设置，或完全退出。',
        },
      }
    : {
        tooltip: 'Shun — running in background',
        backgroundNotice: {
          title: 'Shun is still running',
          content: 'Tasks and background processes continue. Use the tray icon to reopen Shun, open settings, or quit completely.',
        },
      }
}

export function trayMenu(chinese: boolean): TrayEntry[] {
  const command = (command: TrayCommand, label: string): TrayEntry => ({ type: 'command', command, label })
  return chinese
    ? [command('show', '显示主界面'), command('settings', '设置…'), { type: 'separator' }, command('quit', '退出 Shun')]
    : [command('show', 'Open Shun'), command('settings', 'Settings…'), { type: 'separator' }, command('quit', 'Quit Shun')]
}

export function trayLanguageFromState(state: unknown) {
  const settings = (state as { settings?: { language?: unknown } } | null | undefined)?.settings
  return typeof settings?.language === 'string' ? settings.language : undefined
}

export function trayIconPath(appPath: string) {
  return join(appPath, 'resources', 'tray-icon.png')
}

// Closing the Windows window hides Shun into the tray instead of ending the
// session. macOS keeps its existing close semantics, and a tray that could not
// be created falls back to closing so the app can never become unreachable.
export function hidesToTrayOnClose(platform: string, quitting: boolean, trayReady: boolean) {
  return platform === 'win32' && trayReady && !quitting
}

export function createTrayHost(options: TrayOptions) {
  let tray: TrayHandle | undefined
  let language: string | undefined
  let hintShown = false

  const runCommand = (command: TrayCommand) => {
    if (command === 'quit') {
      // The window's close handler hides instead of quitting, so an explicit
      // quit has to end the session before the window is asked to close.
      options.quit()
      return
    }
    options.show()
    if (command === 'settings') options.openSettings()
  }

  const applyLanguage = (value: string | undefined) => {
    if (!tray) return
    const chinese = trayUsesChinese(value, options.locale())
    language = value
    tray.setToolTip(trayLabels(chinese).tooltip)
    tray.setContextMenu(options.createMenu(trayMenu(chinese).map(entry => entry.type === 'separator'
      ? { type: 'separator' as const }
      : { type: 'command' as const, label: entry.label, run: () => runCommand(entry.command) })))
  }

  return {
    install(value: string | undefined) {
      if (options.platform !== 'win32') return false
      const icon = options.loadIcon(options.iconPath)
      if (icon.isEmpty()) {
        // An invisible tray would take away the only way back into a hidden
        // window, so a missing icon keeps the window's existing close behavior.
        options.log?.(`[tray] Unable to load the tray icon at ${options.iconPath}.`)
        return false
      }
      tray = options.createTray(icon)
      tray.onDoubleClick(() => options.show())
      applyLanguage(value)
      return true
    },
    refresh(value: string | undefined) {
      if (value !== language) applyLanguage(value)
    },
    notifyBackground() {
      if (!tray || hintShown) return
      hintShown = true
      tray.displayBalloon(trayLabels(trayUsesChinese(language, options.locale())).backgroundNotice)
    },
    hidesOnClose(quitting: boolean) {
      return hidesToTrayOnClose(options.platform, quitting, Boolean(tray))
    },
  }
}
