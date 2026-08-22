import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { readPdfBytes } from './pdf-reader.ts'

const MAX_PDF_BYTES = 64 * 1024 * 1024

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback
}

export function pdfReadCharacterLimit(value: unknown) { return clamp(value, 12_000, 1_000, 20_000) }
export function pdfReadCharacterOffset(value: unknown) { return clamp(value, 0, 0, 20_000_000) }

function inside(root: string, target: string) {
  return target === root || target.startsWith(root + sep)
}

export async function workspacePdfPath(workspace: string, value: unknown) {
  if (!workspace) throw Error('A workspace is required to read a local PDF.')
  const requested = String(value || '').trim()
  if (!requested) throw Error('PDF path is required.')
  const root = await realpath(resolve(workspace))
  const lexicalTarget = resolve(root, requested)
  if (!inside(root, lexicalTarget)) throw Error('PDF path escapes the selected workspace.')
  const target = await realpath(lexicalTarget)
  if (!inside(root, target)) throw Error('PDF path resolves outside the selected workspace.')
  if (extname(target).toLowerCase() !== '.pdf') throw Error('read_pdf accepts only .pdf files.')
  return { root, target, relativePath: relative(root, target).split(sep).join('/') }
}

export async function readWorkspacePdf(workspace: string, pathValue: unknown, options: { query?: unknown; maxChars?: unknown; offsetChars?: unknown; startPage?: unknown; endPage?: unknown } = {}) {
  const path = await workspacePdfPath(workspace, pathValue)
  const file = await stat(path.target)
  if (!file.isFile()) throw Error('PDF path must identify a file.')
  if (file.size > MAX_PDF_BYTES) throw Error(`PDF is too large for one read (${Math.ceil(file.size / 1024 / 1024)} MB; limit 64 MB).`)
  const bytes = await readFile(path.target)
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('File does not contain a valid PDF header.')
  const parsed = await readPdfBytes(bytes, {
    maxChars: pdfReadCharacterLimit(options.maxChars),
    offset: pdfReadCharacterOffset(options.offsetChars),
    query: options.query,
    startPage: options.startPage,
    endPage: options.endPage,
    maxPages: 200,
  })
  return JSON.stringify({ ok: true, path: path.relativePath, bytes: file.size, ...parsed }, null, 2)
}
