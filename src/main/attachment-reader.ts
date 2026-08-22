import { DOMParser } from 'linkedom'
import { unzipSync, type Unzipped } from 'fflate'
import type { AttachmentRef } from '../shared.ts'
import { contentWindow } from './content-window.ts'
import { readPdfBytes } from './pdf-reader.ts'

const MAX_OUTPUT = 20_000
const MAX_XML_ENTRY = 16 * 1024 * 1024
const MAX_XML_TOTAL = 32 * 1024 * 1024
const MAX_SEMANTIC_CHARACTERS = 16 * 1024 * 1024
const MAX_SEMANTIC_UNITS = 200_000

export type AttachmentReadOptions = {
  query?: unknown
  maxChars?: unknown
  offsetChars?: unknown
  startPage?: unknown
  endPage?: unknown
  sheet?: unknown
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback
}

function clean(value: unknown) { return String(value || '').replace(/\s+/g, ' ').trim() }
function localName(node: any) { return String(node?.localName || node?.tagName || '').split(':').pop()?.toLowerCase() || '' }
function elements(root: any, name: string) {
  return Array.from(root?.querySelectorAll?.('*') || root?.getElementsByTagName?.('*') || []).filter((node: any) => localName(node) === name) as any[]
}
function directElements(root: any, name?: string) {
  return Array.from(root?.childNodes || []).filter((node: any) => node?.nodeType === 1 && (!name || localName(node) === name)) as any[]
}
function parseXml(value: string) {
  const document = new DOMParser().parseFromString(value, 'text/xml') as any
  if (!document?.documentElement) throw Error('The Office document contains invalid XML.')
  return document
}
function xmlText(node: any) { return elements(node, 't').map(item => String(item.textContent || '')).join('') }
function utf8(bytes: Uint8Array) { return new TextDecoder().decode(bytes) }

function delimitedRow(values: string[], delimiter: string) {
  return values.map(value => value.includes(delimiter) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value).join(delimiter)
}

type SemanticDocument = {
  format: string
  unit: string
  content: string
  units: string[]
  prefix?: string
  attributes?: Record<string, unknown>
}

function visitDelimitedRows(content: string, delimiter: string, visit: (values: string[]) => void) {
  let field = '', quoted = false, row: string[] = []
  const emit = () => {
    row.push(field)
    if (row.length > 1 || row[0].trim()) visit(row)
    field = ''; row = []
  }
  for (let index = 0; index < content.length; index++) {
    const character = content[index]
    if (quoted) {
      if (character === '"') {
        if (content[index + 1] === '"') { field += '"'; index++ } else quoted = false
      } else field += character
    } else if (character === '"' && !field) quoted = true
    else if (character === delimiter) { row.push(field); field = '' }
    else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index++
      emit()
    } else field += character
  }
  if (field || row.length) emit()
}

function delimitedDocument(content: string, delimiter: string): SemanticDocument {
  let columns: string[] = [], irregularRows = 0
  const units: string[] = []
  visitDelimitedRows(content, delimiter, values => {
    if (!columns.length) { columns = values; return }
    if (units.length >= MAX_SEMANTIC_UNITS) throw Error(`Attachment contains more than ${MAX_SEMANTIC_UNITS.toLocaleString('en-US')} semantic units.`)
    if (values.length !== columns.length) irregularRows++
    units.push(delimitedRow(values, delimiter))
  })
  return {
    format: delimiter === '\t' ? 'tsv' : 'csv', unit: 'row', content, units, prefix: delimitedRow(columns, delimiter),
    attributes: { delimiter, columns, row_count: units.length, column_count: columns.length, irregular_rows: irregularRows },
  }
}

function textDocument(content: string, format: string, unit: string, attributes: Record<string, unknown> = {}): SemanticDocument {
  if (content.length > MAX_SEMANTIC_CHARACTERS) throw Error(`Decoded attachment exceeds the ${Math.floor(MAX_SEMANTIC_CHARACTERS / 1024 / 1024)} million character semantic limit.`)
  const units = content.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  if (units.length > MAX_SEMANTIC_UNITS) throw Error(`Attachment contains more than ${MAX_SEMANTIC_UNITS.toLocaleString('en-US')} semantic units.`)
  return { format, unit, content, units, attributes }
}

function attributeLines(attributes: Record<string, unknown>) {
  return Object.entries(attributes).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(' | ') : String(value)}`)
}

function boundedUnits(units: string[], budget: number, reverse = false) {
  const selected: string[] = [], source = reverse ? [...units].reverse() : units
  let used = 0
  for (const unit of source) {
    if (used >= budget) break
    const value = unit.slice(0, Math.max(0, budget - used))
    if (value) selected.push(value)
    used += value.length + 1
  }
  return reverse ? selected.reverse() : selected
}

function readSemanticDocument(document: SemanticDocument, options: AttachmentReadOptions, maxChars: number, offset: number) {
  const base = { format: document.format, unit_kind: document.unit, unit_count: document.units.length, ...(document.attributes || {}) }
  if (options.offsetChars !== undefined) return { ...base, ...contentWindow(document.content, maxChars, offset) }
  const query = clean(options.query), terms = [...new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{1,}|[\u3400-\u9fff]{2,}/g) || [])]
  if (query && terms.length) {
    const matches = document.units.filter(unit => terms.some(term => unit.toLowerCase().includes(term))), prefix = document.prefix ? `${document.prefix}\n` : ''
    const returned = boundedUnits(matches, Math.max(0, maxChars - prefix.length)), content = matches.length ? `${prefix}${returned.join('\n')}`.slice(0, maxChars) : ''
    return { ...base, search_query: query, matched_units: matches.length, returned_units: returned.length, truncated: matches.length > returned.length, has_more: matches.length > returned.length, content }
  }
  if (document.content.length <= maxChars) return { ...base, overview_complete: true, ...contentWindow(document.content, maxChars, 0) }

  const overview = ['--- Attachment overview ---', `Format: ${document.format}`, `Semantic units: ${document.units.length} ${document.unit}s`, ...attributeLines(document.attributes || {})].join('\n')
  const sampleBudget = Math.max(0, Math.min(6_000, maxChars - overview.length - 120)), half = Math.floor(sampleBudget / 2)
  const head = boundedUnits(document.units, half), remaining = document.units.slice(head.length), tail = boundedUnits(remaining, sampleBudget - head.join('\n').length, true)
  const prefix = document.prefix ? `${document.prefix}\n` : '', sample = [
    overview,
    '',
    `--- First ${head.length} ${document.unit}s ---`,
    prefix + head.join('\n'),
    ...(tail.length ? ['', `--- Last ${tail.length} ${document.unit}s ---`, prefix + tail.join('\n')] : []),
  ].join('\n').slice(0, maxChars)
  return {
    ...base, overview_complete: true, sampled_head_units: head.length, sampled_tail_units: tail.length,
    truncated: true, has_more: false, full_content_available: true, content: sample,
  }
}

function officeXml(bytes: Buffer, kind: AttachmentRef['kind']) {
  let total = 0
  const wanted = (name: string) => kind === 'document'
    ? /^(?:word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml|\[Content_Types\]\.xml)$/i.test(name)
    : kind === 'spreadsheet'
      ? /^(?:xl\/(?:workbook|sharedStrings)\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/sheet\d+\.xml|\[Content_Types\]\.xml)$/i.test(name)
      : /^(?:ppt\/(?:slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml|\[Content_Types\]\.xml)$/i.test(name)
  const files = unzipSync(new Uint8Array(bytes), {
    filter(file) {
      if (!wanted(file.name)) return false
      if (file.originalSize > MAX_XML_ENTRY) throw Error(`Office XML entry is too large: ${file.name}`)
      total += file.originalSize
      if (total > MAX_XML_TOTAL) throw Error('Office document expands beyond the 32 MB parsing limit.')
      return true
    },
  })
  if (!files['[Content_Types].xml']) throw Error('ZIP file is not a supported Office Open XML document.')
  return files
}

function documentText(files: Unzipped) {
  const names = Object.keys(files).filter(name => /^word\/(?:document|footnotes|endnotes|header\d+|footer\d+)\.xml$/i.test(name)).sort((a, b) => a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b))
  const sections: string[] = []
  for (const name of names) {
    const document = parseXml(utf8(files[name])), body = elements(document, 'body')[0] || document.documentElement
    const blocks: string[] = []
    for (const child of directElements(body)) {
      if (localName(child) === 'p') {
        const value = xmlText(child).trim()
        if (value) blocks.push(value)
      } else if (localName(child) === 'tbl') {
        const rows = elements(child, 'tr').map(row => elements(row, 'tc').map(cell => elements(cell, 'p').map(xmlText).filter(Boolean).join(' ')).join('\t'))
        if (rows.length) blocks.push(rows.join('\n'))
      }
    }
    if (!blocks.length) {
      const fallback = elements(document, 'p').map(xmlText).map(text => text.trim()).filter(Boolean)
      blocks.push(...fallback)
    }
    if (blocks.length) sections.push(`--- ${name === 'word/document.xml' ? 'Document' : name.replace(/^word\//, '')} ---\n${blocks.join('\n\n')}`)
  }
  return { content: sections.join('\n\n'), sections: sections.length }
}

function relationshipMap(files: Unzipped) {
  const source = files['xl/_rels/workbook.xml.rels']
  if (!source) return new Map<string, string>()
  const document = parseXml(utf8(source)), map = new Map<string, string>()
  for (const item of elements(document, 'relationship')) {
    const id = item.getAttribute('Id'), target = item.getAttribute('Target')
    if (id && target) map.set(id, `xl/${String(target).replace(/^\/?xl\//, '').replace(/^\//, '')}`.replace('/worksheets/../', '/'))
  }
  return map
}

function spreadsheetText(files: Unzipped, requestedSheet: string) {
  const shared = files['xl/sharedStrings.xml'] ? elements(parseXml(utf8(files['xl/sharedStrings.xml'])), 'si').map(xmlText) : []
  const relationships = relationshipMap(files), workbook = files['xl/workbook.xml'] ? parseXml(utf8(files['xl/workbook.xml'])) : null
  const declared = workbook ? elements(workbook, 'sheet').map((sheet, index) => {
    const name = sheet.getAttribute('name') || `Sheet ${index + 1}`, id = sheet.getAttribute('r:id') || sheet.getAttribute('id')
    return { name, path: relationships.get(id) || `xl/worksheets/sheet${index + 1}.xml` }
  }) : []
  const fallback = Object.keys(files).filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)).sort().map((path, index) => ({ name: `Sheet ${index + 1}`, path }))
  const sheets = declared.length ? declared : fallback
  const selected = requestedSheet ? sheets.filter(sheet => sheet.name.toLowerCase() === requestedSheet.toLowerCase()) : sheets
  if (requestedSheet && !selected.length) throw Error(`Spreadsheet has no sheet named "${requestedSheet}". Available sheets: ${sheets.map(sheet => sheet.name).join(', ')}`)
  const sections: string[] = []
  for (const sheet of selected) {
    const source = files[sheet.path]
    if (!source) continue
    const document = parseXml(utf8(source)), rows: string[] = []
    for (const row of elements(document, 'row')) {
      const cells: string[] = []
      for (const cell of directElements(row, 'c')) {
        const reference = cell.getAttribute('r') || '?', type = cell.getAttribute('t') || '', valueNode = directElements(cell, 'v')[0], formulaNode = directElements(cell, 'f')[0]
        let value = valueNode?.textContent || ''
        if (type === 's') value = shared[Number(value)] ?? value
        else if (type === 'inlineStr') value = xmlText(cell)
        else if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE'
        const formula = formulaNode?.textContent ? `=${formulaNode.textContent}` : ''
        cells.push(`${reference}=${formula}${formula && value ? ` => ${value}` : value}`)
      }
      if (cells.length) rows.push(cells.join(' | '))
    }
    sections.push(`--- Sheet: ${sheet.name} ---\n${rows.join('\n') || '[empty sheet]'}`)
  }
  return { content: sections.join('\n\n'), sheets: sheets.map(sheet => sheet.name) }
}

function presentationText(files: Unzipped) {
  const slides = Object.keys(files).filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  const sections = slides.map((name, index) => {
    const document = parseXml(utf8(files[name])), paragraphs = elements(document, 'p').map(xmlText).map(text => text.trim()).filter(Boolean)
    const notesName = `ppt/notesSlides/notesSlide${index + 1}.xml`, notes = files[notesName] ? elements(parseXml(utf8(files[notesName])), 'p').map(xmlText).map(text => text.trim()).filter(Boolean) : []
    return `--- Slide ${index + 1} ---\n${paragraphs.join('\n') || '[no extractable slide text]'}${notes.length ? `\n\nNotes:\n${notes.join('\n')}` : ''}`
  })
  return { content: sections.join('\n\n'), slides: slides.length }
}

export function decodeText(bytes: Buffer) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(Math.max(0, bytes.length - 2))
    for (let index = 2; index + 1 < bytes.length; index += 2) { swapped[index - 2] = bytes[index + 1]; swapped[index - 1] = bytes[index] }
    return swapped.toString('utf16le')
  }
  return bytes.toString('utf8').replace(/^\uFEFF/, '')
}

export async function readAttachmentBytes(meta: AttachmentRef, bytes: Buffer, options: AttachmentReadOptions = {}) {
  const maxChars = clamp(options.maxChars, 12_000, 1_000, MAX_OUTPUT), offset = clamp(options.offsetChars, 0, 0, 20_000_000)
  if (meta.kind === 'pdf') {
    const parsed = await readPdfBytes(bytes, { query: options.query, startPage: options.startPage, endPage: options.endPage, maxPages: 200, maxChars, offset })
    return { ok: true, attachment: meta, ...parsed }
  }
  if (meta.kind === 'image') return { ok: true, attachment: meta, warning: 'This image has no standalone semantic text representation.' }
  if (meta.kind === 'unknown' || meta.kind === 'archive') throw Error(`Attachment type ${meta.mimeType || meta.kind} does not have a safe text parser.`)
  let document: SemanticDocument
  if (meta.kind === 'document') {
    const parsed = documentText(officeXml(bytes, meta.kind))
    document = textDocument(parsed.content, 'docx', 'block', { sections: parsed.sections })
  } else if (meta.kind === 'spreadsheet') {
    const parsed = spreadsheetText(officeXml(bytes, meta.kind), clean(options.sheet))
    document = textDocument(parsed.content, 'xlsx', 'row', { sheets: parsed.sheets })
  } else if (meta.kind === 'presentation') {
    const parsed = presentationText(officeXml(bytes, meta.kind))
    document = textDocument(parsed.content, 'pptx', 'block', { slides: parsed.slides })
  }
  else {
    const content = decodeText(bytes), lowerName = meta.name.toLowerCase(), delimiter = meta.mimeType === 'text/tab-separated-values' || lowerName.endsWith('.tsv') ? '\t' : ','
    if (content.length > MAX_SEMANTIC_CHARACTERS) throw Error(`Decoded attachment exceeds the ${Math.floor(MAX_SEMANTIC_CHARACTERS / 1024 / 1024)} million character semantic limit.`)
    document = meta.mimeType === 'text/csv' || meta.mimeType === 'text/tab-separated-values' || lowerName.endsWith('.csv') || lowerName.endsWith('.tsv')
      ? delimitedDocument(content, delimiter)
      : textDocument(content, 'text', 'line')
  }
  return { ok: true, attachment: meta, ...readSemanticDocument(document, options, maxChars, offset) }
}
