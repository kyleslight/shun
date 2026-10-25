import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostPaths } from '../host/paths.ts'

function launch(file: string, args: string[], detached = false) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', detached, windowsHide: true })
    child.once('error', reject)
    if (detached) { child.once('spawn', () => { child.unref(); resolve() }) }
    else child.once('exit', code => code === 0 ? resolve() : reject(Error('Shun Desktop is not installed or could not open. Run shun desktop --install.')))
  })
}

export async function openDesktop(taskId?: string) {
  const url = `shun://task/${taskId || ''}`
  if (process.platform === 'darwin') return launch('/usr/bin/open', [url])
  if (process.platform === 'win32') return launch('rundll32.exe', ['url.dll,FileProtocolHandler', url])
  try {
    const path = (await readFile(join(hostPaths().serviceRoot, 'desktop-path'), 'utf8')).trim()
    if (path) return launch(path, [url], true)
  } catch {}
  return launch('xdg-open', [url])
}

/** Download only official published assets and verify their release checksum. */
export async function installDesktop(report: (message: string) => void) {
  const platform = process.platform, arch = process.arch
  if (!((platform === 'darwin' && arch === 'arm64') || (['linux', 'win32'].includes(platform) && arch === 'x64'))) throw Error('A desktop installer is not available for this platform yet.')
  report('Finding the latest Shun Desktop release…')
  const releaseResponse = await fetch('https://api.github.com/repos/kyleslight/shun/releases/latest', { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30_000) })
  if (!releaseResponse.ok) throw Error('Shun could not find a desktop release. Try again later.')
  const release = await releaseResponse.json() as { assets: Array<{ name: string; browser_download_url: string; size: number }> }
  const asset = release.assets.find(item => platform === 'darwin' ? /^Shun-[\d.]+-arm64\.dmg$/.test(item.name) : platform === 'win32' ? /^Shun-Setup-[\d.]+-x64\.exe$/.test(item.name) : /^Shun-[\d.]+-x64\.AppImage$/.test(item.name))
  const checksums = release.assets.find(item => item.name === 'SHA256SUMS.txt')
  if (!asset || !checksums) throw Error('This desktop release is incomplete. Try again after the release finishes.')
  const download = async (url: string) => {
    if (!url.startsWith('https://github.com/kyleslight/shun/releases/download/')) throw Error('Invalid Shun release asset.')
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
    if (!response.ok) throw Error('Shun download failed. Please retry.')
    return response
  }
  const sums = await (await download(checksums.browser_download_url)).text()
  const line = sums.split('\n').find(line => line.trim().split(/\s+/).at(-1)?.replace(/^\*/, '').split('/').at(-1) === asset.name)
  const expected = line?.trim().split(/\s+/)[0]
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) throw Error('Shun installer checksum is missing.')
  report(`Downloading ${asset.name}…`)
  const response = await download(asset.browser_download_url)
  if (!response.body || asset.size > 1024 ** 3) throw Error('Invalid Shun installer size.')
  const chunks: Uint8Array[] = []; let size = 0
  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    size += chunk.length
    if (size > asset.size || size > 1024 ** 3) throw Error('Shun installer exceeded its expected size.')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (size !== asset.size || createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) throw Error('Shun installer verification failed. Nothing was installed.')
  const directory = join(hostPaths().serviceRoot, 'downloads')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, asset.name)
  await writeFile(`${path}.tmp`, bytes, { mode: 0o600 }); await rename(`${path}.tmp`, path)
  if (platform === 'linux') {
    await chmod(path, 0o700)
    await writeFile(join(hostPaths().serviceRoot, 'desktop-path'), path, { mode: 0o600 })
    report('Shun Desktop installed. Run shun desktop to open it.')
  } else {
    await launch(platform === 'darwin' ? '/usr/bin/open' : path, platform === 'darwin' ? [path] : [], platform === 'win32')
    report('Installer opened. Finish installing Shun Desktop, then run shun desktop to connect your task.')
  }
}
