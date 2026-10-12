/**
 * The hidden Chromium the research path renders through.
 *
 * It lives in its own module because two callers need exactly this renderer: the
 * application's web tools, and the research benchmark, which has to measure the
 * channel the product actually uses. A renderer written inside the harness would
 * measure a different system, and a second implementation would drift.
 */
import { app, BrowserWindow } from 'electron'
import { webUserAgent, withinWebDeadline, type RenderPage } from './web.ts'

/**
 * How long one page may take to render before the read is reported as unfinished.
 *
 * Navigation has its own grace below, because an anti-bot interstitial can keep it
 * pending while its challenge reloads. Everything after it is bounded by this: a page
 * whose renderer never answers used to leave the tool — and the whole run — waiting on
 * it forever, with nothing on screen but a spinner.
 */
export const renderPageDeadlineMs = 45_000

/** The longest one step inside the render — a probe, a snapshot — may take. */
const renderStepTimeoutMs = 10_000

export const renderWebPage: RenderPage = async (url, options) => {
  const network = options?.network || 'configured', signal = options?.signal
  const startedAt = Date.now()
  const page = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { partition: `shun-web-research-${network}`, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: !app.isPackaged },
  })
  const close = () => { if (!page.isDestroyed()) page.destroy() }
  // A stopped run closes the page it was waiting on, rather than leaving a hidden
  // Chromium behind and the tool still holding a promise nobody wants.
  const onAbort = () => close()
  const budget = (ms: number) => Math.max(1, Math.min(ms, renderPageDeadlineMs - (Date.now() - startedAt)))
  const bounded = <T>(work: Promise<T>, ms: number, what: string) =>
    withinWebDeadline(work, { ms: budget(ms), signal, message: `the page did not finish ${what} within ${Math.round(renderPageDeadlineMs / 1000)}s` })
  try {
    if (signal?.aborted) throw Error('the run was stopped before this page could be read')
    signal?.addEventListener('abort', onAbort, { once: true })
    await page.webContents.session.setProxy({ mode: network === 'direct' ? 'direct' : 'system' })
    // Research pages are never user-facing. Muting before navigation prevents
    // autoplay audio from leaking out of an otherwise hidden Chromium window.
    page.webContents.setAudioMuted(true)
    page.webContents.on('media-started-playing', () => {
      if (!page.isDestroyed()) page.webContents.setAudioMuted(true)
    })
    page.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    page.webContents.setUserAgent(webUserAgent())
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        page.loadURL(url, { extraHeaders: 'Accept-Language: zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7\n' }),
        // Some anti-bot interstitials keep the navigation pending while their
        // JavaScript challenge reloads. After the bound, inspect the current DOM
        // instead of discarding a page that may already contain usable evidence.
        new Promise<void>(resolve => {
          timer = setTimeout(() => {
            resolve()
            if (!page.isDestroyed()) page.webContents.stop()
          }, budget(25_000))
        }),
      ])
    } catch (error) {
      // Chromium can reject a navigation after an HTTP interstitial has already
      // committed. Preserve that DOM so the caller can classify it as a block.
      if (signal?.aborted) throw Error('the run was stopped before this page could be read')
      if (!/^https?:/i.test(page.webContents.getURL())) throw error
    } finally { clearTimeout(timer) }
    let previous = '', stable = 0
    for (let attempt = 0; attempt < 7 && stable < 2; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 350))
      const signature = String(await bounded(page.webContents.executeJavaScript('`${document.querySelectorAll("a[href]").length}:${document.body?.innerText?.length || 0}`') as Promise<unknown>, renderStepTimeoutMs, 'settling'))
      stable = signature === previous ? stable + 1 : 0
      previous = signature
    }
    const snapshot = await bounded(page.webContents.executeJavaScript(`({
      html: document.documentElement.outerHTML,
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 3000).map(anchor => ({
        href: anchor.href,
        title: (anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.querySelector('img')?.getAttribute('alt') || anchor.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 500)
      })).filter(link => link.href && link.title)
    })`) as Promise<any>, renderStepTimeoutMs, 'handing over its content')
    const manifest = JSON.stringify({ renderedLinks: snapshot.links || [] }).replace(/<\/script/gi, '<\\/script')
    return { html: `${String(snapshot.html || '').slice(0, 5_000_000)}<script type="application/json">${manifest}</script>`, finalUrl: page.webContents.getURL() }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    close()
  }
}
