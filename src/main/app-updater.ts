import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared'
import { updateFailure, updateProgress } from './update-state'

const { autoUpdater } = electronUpdater
const CHECK_INTERVAL_MS = 10 * 60 * 1000

export class AppUpdateService {
  private state: UpdateState
  private checkPromise?: Promise<UpdateState>
  private downloadPromise?: Promise<UpdateState>
  private timer?: NodeJS.Timeout

  constructor() {
    this.state = {
      status: app.isPackaged ? 'idle' : 'disabled',
      currentVersion: app.getVersion(),
      message: app.isPackaged ? undefined : 'Updates are only available in installed builds.',
    }
  }

  registerIpc() {
    ipcMain.handle('updater:state', () => this.snapshot())
    ipcMain.handle('updater:check', () => this.check())
    ipcMain.handle('updater:download', () => this.download())
    ipcMain.handle('updater:install', () => this.install())
  }

  start() {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.autoRunAppAfterInstall = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = {
      info: message => console.info('[updater]', message),
      warn: message => console.warn('[updater]', message),
      error: message => console.error('[updater]', message),
    }
    autoUpdater.on('checking-for-update', () => this.setState({ ...this.state, status: 'checking', message: undefined }))
    autoUpdater.on('update-available', info => this.setState({ status: 'available', currentVersion: app.getVersion(), targetVersion: info.version }))
    autoUpdater.on('update-not-available', () => this.setState({ status: 'up-to-date', currentVersion: app.getVersion() }))
    autoUpdater.on('download-progress', info => this.setState(updateProgress(this.state, info.percent)))
    autoUpdater.on('update-downloaded', info => this.setState({ status: 'ready', currentVersion: app.getVersion(), targetVersion: info.version, percent: 100 }))
    autoUpdater.on('error', error => this.setState({ ...updateFailure(app.getVersion(), error), targetVersion: this.state.targetVersion }))

    setTimeout(() => void this.check(), 3_000).unref()
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  snapshot(): UpdateState {
    return { ...this.state }
  }

  check(): Promise<UpdateState> {
    if (!app.isPackaged) return Promise.resolve(this.snapshot())
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = autoUpdater.checkForUpdates()
      .then(() => this.snapshot())
      .catch(error => {
        this.setState({ ...updateFailure(app.getVersion(), error), targetVersion: this.state.targetVersion })
        return this.snapshot()
      })
      .finally(() => { this.checkPromise = undefined })
    return this.checkPromise
  }

  download(): Promise<UpdateState> {
    if (this.state.status === 'ready' || !app.isPackaged) return Promise.resolve(this.snapshot())
    if (this.state.status !== 'available') return Promise.resolve(this.snapshot())
    if (this.downloadPromise) return this.downloadPromise
    const targetVersion = this.state.targetVersion
    this.setState({ ...this.state, status: 'downloading', percent: 0, message: undefined })
    this.downloadPromise = autoUpdater.downloadUpdate()
      .then(() => this.snapshot())
      .catch(error => {
        this.setState({ ...updateFailure(app.getVersion(), error), targetVersion })
        return this.snapshot()
      })
      .finally(() => { this.downloadPromise = undefined })
    return this.downloadPromise
  }

  install() {
    if (!app.isPackaged || this.state.status !== 'ready') return false
    setImmediate(() => autoUpdater.quitAndInstall(false, true))
    return true
  }

  private setState(state: UpdateState) {
    this.state = state
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('updater:state', this.snapshot())
    }
  }
}
