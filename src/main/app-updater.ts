import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { basename } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateDownloadedEvent } from 'electron-updater'
import type { UpdateState } from '../shared'
import { updateFailure, updateProgress } from './update-state'
import { releaseProbe } from './release-probe'
import { digestForFile, parseChecksums, releaseSources, releaseTagBase, selectReleaseSource, updateMetadataFile, type ReleaseSelection } from './release-sources'

const { autoUpdater } = electronUpdater
const CHECK_INTERVAL_MS = 10 * 60 * 1000
const SOURCE_TTL_MS = 30 * 60 * 1000
const PROBE_BYTES = 1_048_576
const UPDATE_OWNER = 'kyleslight'
const UPDATE_REPO = 'shun'

/**
 * Public releases live on GitHub Releases, which is slow or unreachable from
 * parts of the world where Shun is used, so the feed measures every reachable
 * release source and downloads from the fastest one. An operator can point
 * Shun at its own mirror with SHUN_UPDATE_BASE; that source is preferred.
 */
const officialUpdateBase = String(process.env.SHUN_UPDATE_BASE || '').trim()

function fileDigest(path: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export class AppUpdateService {
  private state: UpdateState
  private checkPromise?: Promise<UpdateState>
  private downloadPromise?: Promise<UpdateState>
  private timer?: NodeJS.Timeout
  private selection?: { selection: ReleaseSelection; at: number }
  private appliedFeed?: string
  private failedSources = new Set<string>()

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
    autoUpdater.on('update-available', info => this.setState({ status: 'available', currentVersion: app.getVersion(), targetVersion: info.version, message: this.sourceMessage('available') }))
    autoUpdater.on('update-not-available', () => this.setState({ status: 'up-to-date', currentVersion: app.getVersion() }))
    autoUpdater.on('download-progress', info => this.setState(updateProgress(this.state, info.percent)))
    autoUpdater.on('update-downloaded', info => void this.confirmDownload(info))
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

  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.snapshot()
    if (this.checkPromise) return this.checkPromise
    this.checkPromise = this.applyReleaseSource('check')
      .then(() => autoUpdater.checkForUpdates())
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
    this.setState({ ...this.state, status: 'downloading', percent: 0, message: this.sourceMessage('downloading') })
    this.downloadPromise = this.downloadFrom(0)
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

  /**
   * Retry through the remaining reachable sources when the chosen one fails,
   * so a mirror that dies mid-release does not block the update.
   */
  private async downloadFrom(attempt: number): Promise<UpdateState> {
    try {
      await autoUpdater.downloadUpdate()
      return this.snapshot()
    } catch (error) {
      const failed = this.selection?.selection.source
      if (attempt >= 1 || !failed) throw error
      console.warn('[updater]', `Download through ${failed.label} failed:`, error instanceof Error ? error.message : error)
      this.failedSources.add(failed.id)
      this.selection = undefined
      this.appliedFeed = undefined
      await this.applyReleaseSource('download', { fresh: true })
      return this.downloadFrom(attempt + 1)
    }
  }

  private sources() {
    return releaseSources({ owner: UPDATE_OWNER, repo: UPDATE_REPO, officialBase: officialUpdateBase || undefined })
      .filter(source => !this.failedSources.has(source.id))
  }

  /** Point electron-updater at the measured source before it talks to the network. */
  private async applyReleaseSource(mode: 'check' | 'download', options: { fresh?: boolean } = {}) {
    const cached = this.selection
    if (!options.fresh && cached && Date.now() - cached.at < SOURCE_TTL_MS && !this.failedSources.has(cached.selection.source.id)) return cached.selection
    const selection = await selectReleaseSource({
      sources: this.sources(),
      metadataFile: updateMetadataFile(process.platform),
      probe: releaseProbe,
      measureThroughput: mode === 'download',
      probeBytes: PROBE_BYTES,
    }).catch(error => {
      console.warn('[updater] Release source probe failed:', error instanceof Error ? error.message : error)
      return undefined
    })
    if (!selection) return undefined
    this.selection = { selection, at: Date.now() }
    if (this.appliedFeed !== selection.source.base) {
      autoUpdater.setFeedURL({ provider: 'generic', url: selection.source.base })
      // Mirrors are third-party hops, so keep verification to whole-file digests.
      autoUpdater.disableDifferentialDownload = selection.source.kind === 'mirror'
      this.appliedFeed = selection.source.base
      console.info('[updater]', `Update source: ${selection.source.label} (${selection.source.kind})`)
    }
    return selection
  }

  /**
   * A mirrored package is only installed after its published SHA-256 matches.
   * Checksums come from the directly hosted release, so an unreliable mirror
   * cannot decide for itself whether its package is genuine.
   */
  private async confirmDownload(info: UpdateDownloadedEvent) {
    const selection = this.selection?.selection
    const version = info.version
    const download = { status: 'ready' as const, currentVersion: app.getVersion(), targetVersion: version, percent: 100 }
    if (!selection || selection.source.kind === 'direct') {
      this.setState(download)
      return
    }
    const name = basename(info.downloadedFile || '')
    const published = await this.publishedDigest(version, name).catch(() => undefined)
    if (!published) {
      // Without an independent digest the package stays uninstalled-on-quit and
      // needs an explicit click, which is stated in the update message.
      autoUpdater.autoInstallOnAppQuit = false
      this.setState({ ...download, message: `${this.sourceMessage('ready')} Published checksums were unreachable, so this download could not be cross-checked.` })
      return
    }
    const actual = await fileDigest(info.downloadedFile).catch(() => '')
    if (actual !== published) {
      autoUpdater.autoInstallOnAppQuit = false
      this.setState({
        status: 'error',
        currentVersion: app.getVersion(),
        targetVersion: version,
        message: `The update downloaded from ${selection.source.label} did not match the published checksum, so it will not be installed. Try again later.`,
      })
      return
    }
    autoUpdater.autoInstallOnAppQuit = true
    this.setState({ ...download, message: `${this.sourceMessage('ready')} Checksum verified against the published release.` })
  }

  private async publishedDigest(version: string, name: string) {
    if (!name) return undefined
    // Prefer an operator-hosted base, then the directly hosted GitHub release,
    // so the digest never comes from the mirror that served the package.
    const hosted = releaseSources({ owner: UPDATE_OWNER, repo: UPDATE_REPO, officialBase: officialUpdateBase || undefined })
      .filter(source => source.kind !== 'mirror')
    for (const source of hosted) try {
      const { body } = await releaseProbe.text(`${releaseTagBase(source, version)}SHA256SUMS.txt`, 8_000)
      const digest = digestForFile(parseChecksums(body), name)
      if (digest) return digest
    } catch {}
    return undefined
  }

  private sourceMessage(status: 'available' | 'downloading' | 'ready') {
    const source = this.selection?.selection.source
    if (!source) return undefined
    if (source.kind === 'direct') return undefined
    const action = status === 'available' ? 'Update available from' : status === 'downloading' ? 'Downloading update from' : 'Update downloaded from'
    return `${action} ${source.label}.`
  }

  private setState(state: UpdateState) {
    this.state = state
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('updater:state', this.snapshot())
    }
  }
}
