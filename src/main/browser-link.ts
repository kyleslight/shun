import { randomUUID } from 'node:crypto'

/** Run-local references preserve observed destinations without rewriting signed URLs. */
export class BrowserLinkReferences {
  readonly #links = new Map<string, string>()
  readonly #limit: number

  constructor(limit = 256) { this.#limit = limit }

  annotate(output: string) {
    let document: any
    try { document = JSON.parse(output) } catch { return output }
    const remember = (message: any) => {
      if (!Array.isArray(message?.links)) return
      message.links = message.links.map((link: any) => {
        if (!link || typeof link.url !== 'string' || !isHttpUrl(link.url)) return link
        const ref = `link:${randomUUID()}`
        this.#links.set(ref, link.url)
        while (this.#links.size > this.#limit) this.#links.delete(this.#links.keys().next().value!)
        return { ...link, link_ref: ref }
      })
    }
    remember(document)
    if (Array.isArray(document?.messages)) document.messages.forEach(remember)
    return JSON.stringify(document)
  }

  resolve(args: { url?: string; link_ref?: string }) {
    if (Boolean(args.url) === Boolean(args.link_ref)) throw Error('Provide exactly one url or link_ref. Use a link_ref from the current mail reading without reconstructing its URL.')
    if (args.link_ref) {
      const url = this.#links.get(args.link_ref)
      if (!url) throw Error('That link reference is not available in this run. Read the matching message again and use its current link_ref.')
      return url
    }
    if (!isHttpUrl(args.url!)) throw Error('Browser links require an absolute HTTP(S) URL.')
    return args.url!
  }
}

function isHttpUrl(value: string) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
}
