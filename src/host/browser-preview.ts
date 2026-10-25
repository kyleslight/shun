import { randomUUID } from 'node:crypto'
import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page, type KeyInput } from 'puppeteer-core'
import { PUPPETEER_REVISIONS } from 'puppeteer-core/internal/revisions.js'
import { Browser as BrowserKind, computeExecutablePath, install } from '@puppeteer/browsers'
import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

type Preview = { page: Page; console: unknown[]; network: unknown[] }
/** Managed, headless previews never attach to a person's Chrome profile. */
export class HostBrowserPreview {
  private root: string
  private browser?: Promise<Browser>
  private pages = new Map<string, Promise<Preview>>()
  constructor(root: string) { this.root = root }
  private async launch() {
    const cacheDir = join(this.root, 'browsers'), buildId = PUPPETEER_REVISIONS.chrome
    const executablePath = computeExecutablePath({ browser: BrowserKind.CHROME, buildId, cacheDir })
    await access(executablePath).catch(async () => { await install({ browser: BrowserKind.CHROME, buildId, cacheDir }) })
    await mkdir(join(this.root, 'preview-profile'), { recursive: true, mode: 0o700 })
    return puppeteer.launch({ executablePath, headless: true, userDataDir: join(this.root, 'preview-profile'), defaultViewport: { width: 1280, height: 800 } })
  }
  private page(taskId: string) {
    let pending = this.pages.get(taskId)
    if (!pending) {
      pending = (async () => {
        const browser = await (this.browser ||= this.launch().catch(error => { this.browser = undefined; throw error }))
        const context = await browser.createBrowserContext(), page = await context.newPage()
        const preview: Preview = { page, console: [], network: [] }
        const push = (list: unknown[], item: unknown) => { list.push(item); if (list.length > 100) list.shift() }
        page.on('console', item => push(preview.console, { level: item.type(), message: item.text().slice(0, 2000) }))
        page.on('pageerror', error => push(preview.console, { level: 'error', message: String(error).slice(0, 2000) }))
        page.on('response', response => push(preview.network, { url: response.url(), status: response.status() }))
        page.on('requestfailed', request => push(preview.network, { url: request.url(), error: request.failure()?.errorText }))
        return preview
      })().catch(error => { this.pages.delete(taskId); throw error })
      this.pages.set(taskId, pending)
    }
    return pending
  }
  async inspect(taskId: string, options: { url?: string; screenshot?: boolean; viewport?: { width: number; height: number } } = {}) {
    const preview = await this.page(taskId), { page } = preview
    if (options.viewport) await page.setViewport(options.viewport)
    if (options.url && page.url() !== options.url) await page.goto(httpUrl(options.url), { waitUntil: 'domcontentloaded', timeout: 30000 })
    const dom = await page.evaluate((generation) => ({ title: document.title, text: document.body?.innerText.slice(0, 20000) || '', controls: Array.from(document.querySelectorAll('a,button,input,textarea,select')).slice(0, 150).map((element, index) => {
      const ref = `preview-${generation}-${index}`; element.setAttribute('data-shun-preview-ref', ref)
      return { ref, tag: element.tagName.toLowerCase(), name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 100) || element.getAttribute('placeholder'), type: element.getAttribute('type') }
    }) }), randomUUID().replaceAll('-', '').slice(0, 12))
    const diagnostics = { url: page.url(), ...dom, console: preview.console, network: preview.network, viewport: page.viewport() }
    return { content: [{ type: 'text' as const, text: JSON.stringify(diagnostics) }, ...(options.screenshot ? [{ type: 'image' as const, mimeType: 'image/png' as const, data: Buffer.from(await page.screenshot()).toString('base64') }] : [])], details: { url: page.url() } }
  }
  async act(taskId: string, action: { type: string; url?: string; ref?: string; selector?: string; value?: string; key?: string; x?: number; y?: number }) {
    const existing = this.pages.get(taskId)
    if (!existing) throw Error('Inspect a preview page before interacting with it.')
    const { page } = await existing
    const selector = action.ref ? `[data-shun-preview-ref="${validRef(action.ref)}"]` : action.selector
    if (action.type === 'navigate') await page.goto(httpUrl(action.url || ''), { waitUntil: 'domcontentloaded' })
    else if (action.type === 'back') await page.goBack({ waitUntil: 'domcontentloaded' })
    else if (action.type === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' })
    else if (action.type === 'refresh') await page.reload({ waitUntil: 'domcontentloaded' })
    else if (action.type === 'press') await page.keyboard.press(action.key as KeyInput)
    else if (action.type === 'scroll') await page.evaluate(({ x, y }) => window.scrollBy(x || 0, y || 0), action)
    else {
      if (!selector) throw Error('Use a control ref from the latest preview snapshot.')
      if (action.type === 'click') await page.click(selector)
      else if (action.type === 'fill') await page.locator(selector).fill(action.value || '')
      else if (action.type === 'select') await page.select(selector, action.value || '')
      else throw Error('Unknown preview action.')
    }
    return this.inspect(taskId)
  }
  tools(taskId: string) {
    return [
      defineTool({ name: 'browser_debug', label: 'Inspect Browser Preview', description: 'Inspect a page in Shun’s isolated headless Browser Preview. Uses managed Chrome for Testing, never the user’s Chrome or its login state. Returns page text, control refs, console and network diagnostics; screenshot=true includes an image. The first call installs the managed browser if needed.', parameters: Type.Object({ url: Type.String(), screenshot: Type.Optional(Type.Boolean()), viewport: Type.Optional(Type.Object({ width: Type.Integer({ minimum: 240, maximum: 3840 }), height: Type.Integer({ minimum: 240, maximum: 2160 }) })) }), execute: async (_id, args) => this.inspect(taskId, args) }),
      defineTool({ name: 'browser_preview_act', label: 'Interact with Browser Preview', description: 'Operate the isolated preview page using current control refs, then inspect the result. External writes require user authorization. To use an existing signed-in Chrome tab, use Browser Use instead.', parameters: Type.Object({ action: Type.Object({ type: Type.Union(['navigate', 'back', 'forward', 'refresh', 'click', 'fill', 'press', 'select', 'scroll'].map(value => Type.Literal(value))), url: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), selector: Type.Optional(Type.String()), value: Type.Optional(Type.String()), key: Type.Optional(Type.String()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()) }) }), execute: async (_id, args) => this.act(taskId, args.action) }),
    ]
  }
  async close() { const browser = await this.browser?.catch(() => undefined); await browser?.close(); this.pages.clear(); this.browser = undefined }
}
function httpUrl(value: string) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw Error('Preview requires an HTTP or HTTPS URL.'); return url.href }
function validRef(value: string) { if (!/^preview-[a-f0-9]{12}-\d+$/.test(value)) throw Error('Invalid preview ref.'); return value }
