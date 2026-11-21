import { createReadStream, createWriteStream } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AttachmentStore } from './attachments.ts'

/**
 * An image block whose bytes live in the task's attachment store.
 *
 * A transcript is the model's memory, and a picture in it used to be the picture
 * itself: base64 in the session file, parsed into a string that stayed in the
 * main process for as long as the session was open. One long conversation held
 * hundreds of megabytes of pixels it had already finished looking at. The bytes
 * belong in the attachment store, which is where every other image in a task
 * already lives; the transcript keeps the reference and the model still sees the
 * picture, resolved at the provider boundary.
 */
export type StoredImageBlock = { type: 'image'; mimeType: string; data: string; attachmentId?: string }

/**
 * How much resolved image data one run keeps.
 *
 * A context window is not one picture: measured over a long personal
 * conversation, the median window held one image but the tail held fifty-two,
 * nearly 17 MB of pixels. A count-based bound would thrash on exactly those
 * windows, so the cache is bounded by the bytes it actually holds.
 */
const RESOLVED_IMAGE_CACHE_BYTES = 24 * 1024 * 1024

type ResolvedImage = { mimeType: string; data: string }

/** Resolved images for one run, oldest first, bounded by total bytes. */
export type ImageCache = { entries: Map<string, ResolvedImage>; bytes: number }

export const imageCache = (): ImageCache => ({ entries: new Map(), bytes: 0 })

function remember(cache: ImageCache, id: string, image: ResolvedImage) {
  cache.entries.set(id, image)
  cache.bytes += image.data.length
  while (cache.bytes > RESOLVED_IMAGE_CACHE_BYTES && cache.entries.size > 1) {
    const oldest = cache.entries.keys().next().value as string
    cache.bytes -= cache.entries.get(oldest)!.data.length
    cache.entries.delete(oldest)
  }
}

function imageBlocks(content: unknown): StoredImageBlock[] {
  if (!Array.isArray(content)) return []
  return content.filter((block): block is StoredImageBlock =>
    Boolean(block) && typeof block === 'object' && (block as { type?: unknown }).type === 'image')
}

/** True when this content still carries the pixels themselves. */
export function hasInlineImage(content: unknown) {
  return imageBlocks(content).some(block => typeof block.data === 'string' && block.data.length > 0)
}

/** True when this content points at an attachment instead of carrying pixels. */
export function hasStoredImage(content: unknown) {
  return imageBlocks(content).some(block => typeof block.attachmentId === 'string' && block.attachmentId.length > 0 && !block.data)
}

function imageExtension(mimeType: string) {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/webp') return 'webp'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/bmp') return 'bmp'
  if (mimeType === 'image/tiff') return 'tiff'
  return 'png'
}

/**
 * Move every inline image in one message's content into the attachment store.
 *
 * The stored bytes are the exact bytes the model was shown, so resolving them
 * later reproduces the same base64 and a provider's cached prefix stays valid.
 */
export async function externalizeContent(content: unknown, taskId: string, store: AttachmentStore): Promise<unknown> {
  if (!Array.isArray(content)) return content
  const inline = imageBlocks(content).filter(block => block.data)
  if (!inline.length) return content
  const imported = await store.importBuffers(taskId, inline.map((block, index) => ({
    name: `transcript-image-${index + 1}.${imageExtension(block.mimeType)}`,
    bytes: Buffer.from(block.data, 'base64'),
  })), Number.POSITIVE_INFINITY)
  let cursor = 0
  return content.map(block => {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'image') return block
    const image = block as StoredImageBlock
    if (!image.data) return block
    const attachment = imported[cursor++]
    if (!attachment) return block
    return { type: 'image', mimeType: image.mimeType, data: '', attachmentId: attachment.id }
  })
}

/**
 * Put the pixels back for the messages the model is about to be sent.
 *
 * Only the context window is resolved, so memory follows the conversation the
 * model is actually reading rather than everything the session ever recorded.
 */
export async function resolveContent(content: unknown, taskId: string, store: AttachmentStore, cache: ImageCache): Promise<unknown> {
  if (!Array.isArray(content)) return content
  const resolved: unknown[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'image') { resolved.push(block); continue }
    const image = block as StoredImageBlock
    if (!image.attachmentId || image.data) { resolved.push(block); continue }
    let cached = cache.entries.get(image.attachmentId)
    if (!cached) {
      try {
        const { metadata, bytes } = await store.read(taskId, image.attachmentId)
        // The block's own type is what the model was shown; the store's is only
        // a fallback for a block that never carried one.
        cached = { mimeType: image.mimeType || metadata.mimeType, data: bytes.toString('base64') }
      } catch {
        // The attachment is gone. Say so in the transcript's own words rather
        // than sending a provider an image with no pixels in it.
        resolved.push({ type: 'text', text: `[image unavailable: ${image.attachmentId}]` })
        continue
      }
      remember(cache, image.attachmentId, cached)
    }
    resolved.push({ type: 'image', mimeType: cached.mimeType, data: cached.data })
  }
  return resolved
}

/**
 * Rewrite one session file so its images live in the attachment store.
 *
 * Sessions written before this existed carry their pixels inline, and a session
 * is append-only, so the only way to shrink one is to rewrite it once. The file
 * is streamed line by line and replaced atomically, which keeps the peak cost of
 * migrating a large session to the size of its text.
 */
export async function externalizeSessionFile(path: string, taskId: string, store: AttachmentStore): Promise<boolean> {
  const temporary = `${path}.${process.pid}.externalizing`
  const output = createWriteStream(temporary)
  // A session can be far larger than the stream's buffer, so a line waits for
  // the disk rather than piling up in memory.
  const write = async (line: string) => { if (!output.write(line)) await once(output, 'drain') }
  let changed = false
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      let entry: Record<string, any>
      try { entry = JSON.parse(line) } catch { await write(`${line}\n`); continue }
      const content = entry?.type === 'message' ? entry.message?.content : entry?.type === 'custom_message' ? entry.content : undefined
      if (!hasInlineImage(content)) { await write(`${line}\n`); continue }
      const externalized = await externalizeContent(content, taskId, store)
      if (entry.type === 'message') entry.message.content = externalized
      else entry.content = externalized
      changed = true
      await write(`${JSON.stringify(entry)}\n`)
    }
  } finally { reader.close() }
  output.end()
  await once(output, 'finish')
  if (!changed) {
    await rm(temporary, { force: true })
    return false
  }
  try { await rename(temporary, path) }
  catch (error) { await rm(temporary, { force: true }); throw error }
  return true
}

/**
 * Keep a transcript's images out of the main process.
 *
 * Persistence is where the pixels leave memory: the message is externalized
 * before the session writes it, so neither the agent's state nor the session
 * store ever holds more than a reference. The provider boundary is where they
 * come back, for the context window only.
 */
export function sessionImageExtension(taskId: string, store: AttachmentStore): ExtensionFactory {
  return api => {
    const cache = imageCache()
    api.on('message_end', async event => {
      const content = (event.message as { content?: unknown }).content
      if (!hasInlineImage(content)) return
      const externalized = await externalizeContent(content, taskId, store)
      return { message: { ...event.message, content: externalized } as unknown as AgentMessage }
    })
    api.on('context', async event => {
      const messages = event.messages
      if (!messages.some(message => hasStoredImage((message as { content?: unknown }).content))) return
      const resolved: AgentMessage[] = []
      for (const message of messages) {
        const content = (message as { content?: unknown }).content
        resolved.push(hasStoredImage(content)
          ? { ...message, content: await resolveContent(content, taskId, store, cache) } as unknown as AgentMessage
          : message)
      }
      return { messages: resolved }
    })
  }
}
