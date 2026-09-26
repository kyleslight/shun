import type { AttachmentPreview } from '../shared.ts'
import { normalizeAttachmentRegion, previewAttachmentBytes } from './attachment-preview.ts'
import { readAttachmentBytes } from './attachment-reader.ts'
import type { AttachmentStore } from './attachments.ts'

export type AttachmentReadMode = 'semantic' | 'ocr' | 'visual'
export type AttachmentModelReadOptions = {
  mode?: AttachmentReadMode
  page?: unknown
  region?: unknown
  query?: unknown
  startPage?: unknown
  endPage?: unknown
  sheet?: unknown
  maxChars?: unknown
  offsetChars?: unknown
}

type ModelContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export type AttachmentModelReadResult = {
  content: ModelContent[]
  details: unknown
}

function textResult(value: unknown): AttachmentModelReadResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: value }
}

function imageResult(preview: Extract<AttachmentPreview, { mode: 'image' }>): AttachmentModelReadResult {
  const description = {
    ok: true,
    attachment: preview.attachment,
    mode: 'visual',
    // The frame the model is looking at, and the part of it this read returned.
    // Both are stated because the model has no other way to know whether it was
    // shown the whole picture or a thumbnail of it, and a region read is only
    // useful if it can tell which part it just saw.
    width: preview.width,
    height: preview.height,
    ...(preview.region ? { region: preview.region } : {}),
    page: preview.page,
    pages: preview.pages,
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify(description, null, 2) },
      { type: 'image', mimeType: preview.mimeType, data: preview.data },
    ],
    details: preview,
  }
}

/** One content-aware attachment boundary for both semantic and visual reads. */
export async function readAttachmentForModel(store: AttachmentStore, taskId: string, attachmentId: string, options: AttachmentModelReadOptions = {}): Promise<AttachmentModelReadResult> {
  const { metadata, bytes } = await store.read(taskId, attachmentId), mode = options.mode || 'semantic'
  const region = options.region === undefined ? undefined : normalizeAttachmentRegion(options.region)
  // A region is a question about pixels. A document has no pixels to point at,
  // and answering it silently with the whole document would be a wrong answer
  // that looks like a right one.
  if (region && metadata.kind !== 'image') throw Error(`A region read is only available for image attachments; ${metadata.name} is ${metadata.kind}.`)

  if (metadata.kind === 'image') {
    const preview = await previewAttachmentBytes(metadata, bytes, 1, 'model', region)
    if (preview.mode !== 'image') throw Error(`Image attachment ${metadata.name} did not produce visual content.`)
    return imageResult(preview)
  }

  if (mode === 'ocr' || mode === 'visual') {
    if (metadata.kind !== 'pdf') throw Error(`${mode} mode is only available for image and PDF attachments; ${metadata.name} is ${metadata.kind}.`)
    const page = Number(options.page)
    if (!Number.isInteger(page) || page < 1) throw Error(`PDF ${mode} mode requires one explicit page number.`)
    const preview = await previewAttachmentBytes(metadata, bytes, page, mode)
    if (preview.mode !== 'image') throw Error(`PDF attachment ${metadata.name} did not produce visual content.`)
    return imageResult(preview)
  }

  if (options.page !== undefined) throw Error('page is only valid with PDF ocr or visual mode; use start_page and end_page for semantic PDF reading.')
  return textResult(await readAttachmentBytes(metadata, bytes, {
    query: options.query,
    startPage: options.startPage,
    endPage: options.endPage,
    sheet: options.sheet,
    maxChars: options.maxChars,
    offsetChars: options.offsetChars,
  }))
}
