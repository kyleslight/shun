import { BrowserWindow } from 'electron'
import type { PresentationRenderer } from './presentation'

/** Render only product-generated, self-contained markup; no server or external runtime. */
export const renderPresentationSlide: PresentationRenderer = async (html, signal) => {
  signal?.throwIfAborted()
  const window = new BrowserWindow({
    show: false, width: 1280, height: 720, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false },
  })
  let timeout: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  const stop = () => { if (!window.isDestroyed()) window.destroy() }
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        const overflowingText = await window.webContents.executeJavaScript(`(async () => {
          await document.fonts.ready;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return [...document.querySelectorAll('[data-text]')].filter(el => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1).length;
        })()`)
        signal?.throwIfAborted()
        const image = await window.webContents.capturePage()
        if (image.isEmpty()) throw Error('The presentation preview produced an empty image.')
        return { png: image.resize({ width: 1280, height: 720, quality: 'best' }).toPNG(), overflowingText: Number(overflowingText) }
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { reject(Error('Presentation preview timed out.')); stop() }, 15_000)
        abort = () => { reject(signal?.reason || Error('Presentation preview cancelled.')); stop() }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (abort) signal?.removeEventListener('abort', abort)
    stop()
  }
}
