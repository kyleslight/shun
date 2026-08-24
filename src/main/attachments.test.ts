import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { strToU8, zipSync } from 'fflate'
import type { AttachmentKind, AttachmentRef } from '../shared.ts'
import { readAttachmentForModel } from './attachment-model-read.ts'
import { clearAttachmentPreviewCache, normalizeImageForModel, previewAttachment } from './attachment-preview.ts'
import { readAttachmentBytes } from './attachment-reader.ts'
import { attachmentManifest, AttachmentStore, detectAttachment } from './attachments.ts'

const contentTypes = {
  document: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  spreadsheet: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
} as const

function office(kind: keyof typeof contentTypes, files: Record<string, string>) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<Types><Override ContentType="${contentTypes[kind]}"/></Types>`,
    ...files,
  }).map(([name, value]) => [name, strToU8(value)]))))
}

function metadata(kind: AttachmentKind, name: string, mimeType = 'application/octet-stream'): AttachmentRef {
  return { id: 'file_1', taskId: 'task_1', name, mimeType, kind, size: 1, sha256: 'hash', createdAt: 1, capabilities: { text: true } }
}

test('attachment detection trusts file signatures and recognizes mainstream portable formats', () => {
  const pdf = detectAttachment(Buffer.from('%PDF-1.7\n'), 'wrong.txt')
  assert.equal(pdf.kind, 'pdf')
  assert.deepEqual(pdf.capabilities, { text: true, ocr: true })
  assert.deepEqual(detectAttachment(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'wrong.bin').kind, 'image')
  assert.deepEqual(detectAttachment(Buffer.from('plain utf-8 text'), 'notes.md').kind, 'text')
  assert.deepEqual(detectAttachment(office('document', {}), 'report.docx').kind, 'document')
  assert.deepEqual(detectAttachment(office('spreadsheet', {}), 'data.xlsx').kind, 'spreadsheet')
  assert.deepEqual(detectAttachment(office('presentation', {}), 'deck.pptx').kind, 'presentation')
})

test('attachment admission applies kind-aware resource budgets before storage or preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-attachment-budget-'))
  try {
    const store = new AttachmentStore(join(root, 'store'))
    await assert.rejects(
      () => store.importBuffers('task_1', [{ name: 'oversized.txt', bytes: Buffer.alloc(16 * 1024 * 1024 + 1, 0x61) }]),
      /too large for a text attachment.*limit 16 MB/,
    )
    const oversizedPixels = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(oversizedPixels)
    oversizedPixels.writeUInt32BE(50_000, 16)
    oversizedPixels.writeUInt32BE(50_000, 20)
    await assert.rejects(
      () => store.importBuffers('task_1', [{ name: 'oversized.png', bytes: oversizedPixels }]),
      /unsafe image dimensions.*50,000,000 pixels/,
    )
    assert.deepEqual(await store.list('task_1'), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('built-in OOXML readers extract document, spreadsheet, and presentation semantics', async () => {
  const docx = office('document', {
    'word/document.xml': '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
  })
  const document: any = await readAttachmentBytes(metadata('document', 'report.docx'), docx)
  assert.match(document.content, /Quarterly report/)
  assert.match(document.content, /Total\t42/)

  const xlsx = office('spreadsheet', {
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Revenue" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>Region</t></si><si><t>East</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>20</v></c></row><row><c r="A2" t="s"><v>1</v></c><c r="B2"><f>SUM(B1)</f><v>20</v></c></row></sheetData></worksheet>',
  })
  const spreadsheet: any = await readAttachmentBytes(metadata('spreadsheet', 'data.xlsx'), xlsx, { sheet: 'Revenue' })
  assert.deepEqual(spreadsheet.sheets, ['Revenue'])
  assert.match(spreadsheet.content, /A1=Region \| B1=20/)
  assert.match(spreadsheet.content, /B2==SUM\(B1\) => 20/)

  const pptx = office('presentation', {
    'ppt/slides/slide1.xml': '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Launch plan</a:t></a:r></a:p></p:sld>',
    'ppt/notesSlides/notesSlide1.xml': '<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Internal note</a:t></a:r></a:p></p:notes>',
  })
  const presentation: any = await readAttachmentBytes(metadata('presentation', 'deck.pptx'), pptx)
  assert.equal(presentation.slides, 1)
  assert.match(presentation.content, /Launch plan[\s\S]*Internal note/)
})

test('the common semantic reader summarizes large decoded units and treats a search miss as data', async () => {
  const csv = Buffer.from(['name,note,value', 'alpha,"line one\nline two",1', ...Array.from({ length: 40 }, (_, index) => `item-${index},${'detail-'.repeat(8)}${index},${index}`), 'omega,last,99'].join('\n'))
  const overview: any = await readAttachmentBytes(metadata('text', 'data.csv', 'text/csv'), csv, { maxChars: 1_000 })
  assert.equal(overview.format, 'csv')
  assert.deepEqual(overview.columns, ['name', 'note', 'value'])
  assert.equal(overview.row_count, 42)
  assert.equal(overview.column_count, 3)
  assert.equal(overview.overview_complete, true)
  assert.equal(overview.has_more, false)
  assert.ok(overview.sampled_head_units > 0)
  assert.ok(overview.sampled_tail_units > 0)
  assert.match(overview.content, /alpha,"line one\nline two",1[\s\S]*omega,last,99/)

  const missing: any = await readAttachmentBytes(metadata('text', 'data.csv', 'text/csv'), csv, { query: 'not present' })
  assert.equal(missing.matched_units, 0)
  assert.equal(missing.content, '')
  assert.equal(missing.has_more, false)
})

test('task attachment storage deduplicates content and enforces task ownership and integrity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-attachments-'))
  try {
    const source = join(root, 'source.txt')
    await writeFile(source, 'portable attachment content')
    const store = new AttachmentStore(join(root, 'store'))
    const [first] = await store.importPaths('task_1', [source])
    const [duplicate] = await store.importPaths('task_1', [source])
    assert.equal(duplicate.id, first.id)
    assert.equal((await store.list('task_1')).length, 1)
    assert.equal((await store.read('task_1', first.id)).bytes.toString(), 'portable attachment content')
    assert.match(attachmentManifest([first]), new RegExp(`id=${first.id}`))
    assert.doesNotMatch(attachmentManifest([first]), new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(attachmentManifest([first]), /original source paths are deliberately unavailable/)
    assert.match(attachmentManifest([first]), /never use workspace read, bash, find, or filename search/i)
    assert.match(attachmentManifest([first]), /capabilities=text/)
    assert.match(attachmentManifest([first]), /single content-aware|Read them only by stable ID with attachment_read/i)
    assert.match(attachmentManifest([first]), /returns image content for images and bounded semantic content/i)
    assert.match(attachmentManifest([first]), /mode=ocr or mode=visual with one page/i)
    assert.doesNotMatch(attachmentManifest([first]), /attachment_view/)
    await assert.rejects(() => store.list('../outside'), /Invalid task ID/)
    await writeFile(join(root, 'store', 'task_1', first.id, 'content'), 'tampered')
    await assert.rejects(() => store.read('task_1', first.id), /integrity check/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('model delivery preserves an already-efficient source image instead of degrading dense text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-model-image-'))
  try {
    const source = join(root, 'dense-text.png'), canvas = createCanvas(2406, 1522)
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height)
    const original = canvas.toBuffer('image/png')
    await writeFile(source, original)
    const store = new AttachmentStore(join(root, 'store')), [item] = await store.importPaths('task_1', [source])
    const modelImage = await previewAttachment(store, 'task_1', item.id, 1, 'model')
    assert.equal(modelImage.mode, 'image')
    if (modelImage.mode !== 'image') return
    assert.equal(modelImage.mimeType, 'image/png')
    assert.deepEqual(Buffer.from(modelImage.data, 'base64'), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('genuinely large model images use a high-quality bounded raster', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-large-model-image-'))
  try {
    const source = join(root, 'large.png'), canvas = createCanvas(3600, 1800)
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height)
    await writeFile(source, canvas.toBuffer('image/png'))
    const store = new AttachmentStore(join(root, 'store')), [item] = await store.importPaths('task_1', [source])
    const modelImage = await previewAttachment(store, 'task_1', item.id, 1, 'model')
    assert.equal(modelImage.mode, 'image')
    if (modelImage.mode !== 'image') return
    assert.ok(['image/png', 'image/jpeg'].includes(modelImage.mimeType))
    const rendered = await loadImage(Buffer.from(modelImage.data, 'base64'))
    assert.equal(Math.max(rendered.width, rendered.height), 2560)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tool screenshots reuse the uploaded-image model normalization policy before storage', async () => {
  const canvas = createCanvas(3840, 1872), context = canvas.getContext('2d')
  context.fillStyle = '#101113'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#16a9e0'
  for (let x = 0; x < canvas.width; x += 320) context.fillRect(x, 120, 260, 420)
  const source = canvas.toBuffer('image/png'), normalized = await normalizeImageForModel(source, 'image/png')
  assert.ok(['image/png', 'image/jpeg'].includes(normalized.mimeType))
  assert.equal(Math.max(normalized.width || 0, normalized.height || 0), 2560)
  assert.ok(normalized.bytes.length > 0)
  assert.ok(normalized.bytes.length < source.length)
})

test('opened image previews preserve the original bytes instead of reusing a thumbnail or model image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-display-preview-'))
  try {
    const source = join(root, 'original.png'), canvas = createCanvas(1200, 600), original = canvas.toBuffer('image/png')
    await writeFile(source, original)
    const store = new AttachmentStore(join(root, 'store')), [item] = await store.importPaths('task_1', [source])
    const display = await previewAttachment(store, 'task_1', item.id, 1, 'display')
    assert.equal(display.mode, 'image')
    if (display.mode !== 'image') return
    assert.deepEqual(Buffer.from(display.data, 'base64'), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('remote image previews are bounded for mobile transport and retain dimensions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-remote-preview-'))
  try {
    const source = join(root, 'large-mobile-image.png'), canvas = createCanvas(3200, 2400)
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height)
    await writeFile(source, canvas.toBuffer('image/png'))
    const store = new AttachmentStore(join(root, 'store')), [item] = await store.importPaths('task_1', [source])
    const remote = await previewAttachment(store, 'task_1', item.id, 1, 'remote')
    assert.equal(remote.mode, 'image')
    if (remote.mode !== 'image') return
    assert.equal(Math.max(remote.width || 0, remote.height || 0), 1600)
    assert.ok(remote.data.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('task deletion evicts every in-memory preview owned by that task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-preview-lifecycle-'))
  try {
    clearAttachmentPreviewCache('task_1')
    const store = new AttachmentStore(join(root, 'store')), canvas = createCanvas(40, 30)
    const [item] = await store.importBuffers('task_1', [{ name: 'image.png', bytes: canvas.toBuffer('image/png') }])
    await previewAttachment(store, 'task_1', item.id, 1, 'display')
    await previewAttachment(store, 'task_1', item.id, 1, 'model')
    assert.equal(clearAttachmentPreviewCache('task_1'), 2)
    assert.equal(clearAttachmentPreviewCache('task_1'), 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('PDFs cannot enter a visual path without an explicit OCR or visual intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-limited-preview-'))
  try {
    const source = join(root, 'document.pdf')
    await writeFile(source, Buffer.from('%PDF-1.7\n'))
    const store = new AttachmentStore(join(root, 'store')), [item] = await store.importPaths('task_1', [source])
    await assert.rejects(() => previewAttachment(store, 'task_1', item.id, 1, 'display'), /requires an explicit OCR or visual-inspection intent/)
    await assert.rejects(() => previewAttachment(store, 'task_1', item.id, 1, 'model'), /requires an explicit OCR or visual-inspection intent/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('clipboard image bytes import without requiring a filesystem path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-clipboard-'))
  try {
    const canvas = createCanvas(40, 30)
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height)
    const store = new AttachmentStore(join(root, 'store'))
    const [item] = await store.importBuffers('task_1', [{ name: 'Screenshot.png', bytes: canvas.toBuffer('image/png') }])
    assert.equal(item.kind, 'image')
    assert.equal(item.mimeType, 'image/png')
    assert.equal((await store.read('task_1', item.id)).bytes.length, item.size)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('one content-aware attachment reader returns native image or semantic text content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-unified-attachment-read-'))
  try {
    const store = new AttachmentStore(join(root, 'store')), canvas = createCanvas(40, 30)
    canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height)
    const [image, text] = await store.importBuffers('task_1', [
      { name: 'image.png', bytes: canvas.toBuffer('image/png') },
      { name: 'notes.txt', bytes: Buffer.from('semantic attachment content') },
    ])
    const imageResult = await readAttachmentForModel(store, 'task_1', image.id)
    assert.deepEqual(imageResult.content.map(block => block.type), ['text', 'image'])
    assert.equal(imageResult.content[1].type === 'image' && imageResult.content[1].mimeType, 'image/png')
    const textResult = await readAttachmentForModel(store, 'task_1', text.id)
    assert.deepEqual(textResult.content.map(block => block.type), ['text'])
    assert.match(textResult.content[0].type === 'text' ? textResult.content[0].text : '', /semantic attachment content/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unified PDF visual reading requires an explicit mode and one page', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-unified-pdf-read-'))
  try {
    const store = new AttachmentStore(join(root, 'store')), [pdf] = await store.importBuffers('task_1', [{ name: 'document.pdf', bytes: Buffer.from('%PDF-1.7\n') }])
    await assert.rejects(() => readAttachmentForModel(store, 'task_1', pdf.id, { mode: 'ocr' }), /requires one explicit page number/)
    await assert.rejects(() => readAttachmentForModel(store, 'task_1', pdf.id, { page: 1 }), /page is only valid with PDF ocr or visual mode/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
