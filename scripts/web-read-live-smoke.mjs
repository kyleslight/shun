import { app, BrowserWindow } from 'electron'
import { readWeb, webUserAgent } from '../src/main/web.ts'

const target = process.env.SHUN_WEB_SMOKE_URL
if (!target) throw new Error('Set SHUN_WEB_SMOKE_URL to one public HTTP(S) page before running this live smoke test.')

console.error('[web-smoke] waiting for Electron')

const renderPage = async (url, options) => {
  const network = options?.network || 'configured'
  console.error(`[web-smoke] ${network}: create ${url}`)
  const page = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: `shun-web-smoke-${network}`,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  })
  try {
    await page.webContents.session.setProxy({ mode: network === 'direct' ? 'direct' : 'system' })
    console.error(`[web-smoke] ${network}: proxy ready`)
    page.webContents.setAudioMuted(true)
    page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    page.webContents.setUserAgent(webUserAgent())
    let timer
    try {
      await Promise.race([
        page.loadURL(url, { extraHeaders: 'Accept-Language: zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7\n' }),
        new Promise(resolve => {
          timer = setTimeout(() => {
            console.error(`[web-smoke] ${network}: navigation timeout`)
            resolve()
            if (!page.isDestroyed()) page.webContents.stop()
          }, 25_000)
        }),
      ])
    } catch (error) {
      console.error(`[web-smoke] ${network}: navigation error ${String(error)}`)
      if (!/^https?:/i.test(page.webContents.getURL())) throw error
    } finally { clearTimeout(timer) }
    console.error(`[web-smoke] ${network}: navigation settled ${page.webContents.getURL()}`)
    let previous = '', stable = 0
    for (let attempt = 0; attempt < 7 && stable < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 350))
      const signature = String(await page.webContents.executeJavaScript('`${document.querySelectorAll("a[href]").length}:${document.body?.innerText?.length || 0}`'))
      console.error(`[web-smoke] ${network}: dom ${signature}`)
      stable = signature === previous ? stable + 1 : 0
      previous = signature
    }
    return {
      html: String(await page.webContents.executeJavaScript('document.documentElement.outerHTML')).slice(0, 5_000_000),
      finalUrl: page.webContents.getURL(),
    }
  } finally {
    console.error(`[web-smoke] ${network}: destroy`)
    page.destroy()
  }
}

void app.whenReady().then(async () => {
  console.error('[web-smoke] Electron ready')
  try {
    const output = JSON.parse(await readWeb(target, 8_000, renderPage, 0, undefined, process.env.SHUN_WEB_SMOKE_QUERY || 'identity ownership funding'))
    console.log(JSON.stringify({
      ok: output.ok,
      title: output.title,
      status: output.status,
      final_url: output.final_url,
      fetch_method: output.fetch_method,
      returned_characters: output.returned_characters,
      content_preview: String(output.content || '').slice(0, 500),
    }, null, 2))
    console.log('SHUN_WEB_SMOKE_RESULT=pass')
  } finally { app.quit() }
}).catch(error => {
  console.error(error)
  console.log('SHUN_WEB_SMOKE_RESULT=fail')
  app.quit()
})
