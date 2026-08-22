import { createReadStream } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import type { AttachmentRef } from '../shared.ts'
import { previewAttachmentBytes } from './attachment-preview.ts'

const MAX_OUTPUT_BYTES = 50 * 1024
const MAX_CAPTURED_LINE_CHARS = 16 * 1024
const MAX_TAIL_SCAN_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const STREAM_CHUNK_BYTES = 64 * 1024

export type WorkspaceReadMode = 'content' | 'overview' | 'search' | 'tail'
export type WorkspaceReadOptions = {
  mode?: WorkspaceReadMode
  offset?: unknown
  limit?: unknown
  byteOffset?: unknown
  query?: unknown
  caseSensitive?: unknown
  maxMatches?: unknown
}

type TextContent = { type: 'text'; text: string }
type ImageContent = { type: 'image'; mimeType: string; data: string }
export type WorkspaceReadResult = { content: Array<TextContent | ImageContent>; details: Record<string, unknown> }

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback
}

export async function workspaceFilePath(cwd: string, value: unknown) {
  if (!cwd) throw Error('A task working directory is required to resolve a local file.')
  const requested = String(value || '').trim()
  if (!requested) throw Error('File path is required.')
  const root = await realpath(resolve(cwd)), target = await realpath(resolve(root, requested))
  const relativeTarget = relative(root, target)
  const insideCwd = relativeTarget !== '..' && !relativeTarget.startsWith(`..${sep}`) && !isAbsolute(relativeTarget)
  return { root, target, relativePath: (insideCwd ? relativeTarget || '.' : target).split(sep).join('/') }
}

async function sampleFile(path: string, size: number) {
  const handle = await open(path, 'r')
  try {
    const sample = Buffer.alloc(Math.min(size, 64 * 1024)), { bytesRead } = await handle.read(sample, 0, sample.length, 0)
    return sample.subarray(0, bytesRead)
  } finally { await handle.close() }
}

function imageMime(sample: Buffer) {
  if (sample.length >= 8 && sample.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (sample.length >= 3 && sample[0] === 0xff && sample[1] === 0xd8 && sample[2] === 0xff) return 'image/jpeg'
  if (sample.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif'
  if (sample.length >= 12 && sample.subarray(0, 4).toString('ascii') === 'RIFF' && sample.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (sample.length >= 2 && sample[0] === 0x42 && sample[1] === 0x4d) return 'image/bmp'
  return undefined
}

function seemsBinary(sample: Buffer) {
  if (sample.includes(0)) return true
  const text = sample.toString('utf8'), replacements = (text.match(/\uFFFD/g) || []).length
  return replacements > Math.max(2, text.length * .01)
}

async function readSmallFile(path: string, size: number) {
  const result = Buffer.alloc(size), handle = await open(path, 'r')
  try {
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(result, offset, size - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    return result.subarray(0, offset)
  } finally { await handle.close() }
}

function trimOutput(value: string) {
  const bytes = Buffer.from(value)
  if (bytes.length <= MAX_OUTPUT_BYTES) return value
  return bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8').replace(/\uFFFD$/, '') + '\n[Output truncated at 50 KB]'
}

type ScannedLine = { number: number; text: string; truncated: boolean; matched: boolean }

async function scanLines(
  path: string,
  signal: AbortSignal | undefined,
  options: { query?: string; caseSensitive?: boolean; captureFrom?: number; stop?: (line: ScannedLine) => boolean | void },
) {
  const query = options.query || '', needle = options.caseSensitive ? query : query.toLocaleLowerCase()
  let lineNumber = 1, totalLines = 0, bytesScanned = 0, stopped = false
  let decoder = new StringDecoder('utf8'), captured = '', truncated = false, matched = false, matchTail = '', lineHasBytes = false
  const shouldCapture = () => lineNumber >= (options.captureFrom || 1)
  const consumeText = (part: string) => {
    if (!part) return
    lineHasBytes = true
    if (shouldCapture()) {
      const remaining = Math.max(0, MAX_CAPTURED_LINE_CHARS - captured.length)
      captured += part.slice(0, remaining)
      if (part.length > remaining) truncated = true
    }
    if (needle && !matched) {
      const searchable = options.caseSensitive ? matchTail + part : (matchTail + part).toLocaleLowerCase()
      matched = searchable.includes(needle)
      matchTail = searchable.slice(-Math.max(0, needle.length - 1))
    }
  }
  const finishLine = () => {
    consumeText(decoder.end())
    if (captured.endsWith('\r')) captured = captured.slice(0, -1)
    const line = { number: lineNumber, text: captured, truncated, matched }
    totalLines = lineNumber
    const keepGoing = options.stop?.(line) !== false
    lineNumber++
    decoder = new StringDecoder('utf8'); captured = ''; truncated = false; matched = false; matchTail = ''; lineHasBytes = false
    if (!keepGoing) stopped = true
  }

  const stream = createReadStream(path, { highWaterMark: STREAM_CHUNK_BYTES, signal })
  for await (const value of stream) {
    const chunk = value as Buffer
    bytesScanned += chunk.length
    let start = 0
    while (!stopped) {
      const newline = chunk.indexOf(0x0a, start)
      if (newline < 0) { consumeText(decoder.write(chunk.subarray(start))); break }
      consumeText(decoder.write(chunk.subarray(start, newline + 1)).replace(/\n$/, ''))
      finishLine()
      start = newline + 1
      if (start >= chunk.length) break
    }
    if (stopped) { stream.destroy(); break }
  }
  if (!stopped && (bytesScanned === 0 || lineHasBytes)) finishLine()
  return { totalLines, bytesScanned, stopped }
}

async function readLineRange(path: string, relativePath: string, size: number, offsetValue: unknown, limitValue: unknown, signal?: AbortSignal) {
  const offset = clamp(offsetValue, 1, 1, Number.MAX_SAFE_INTEGER), limit = clamp(limitValue, 400, 1, 2_000)
  const lines: string[] = []
  let lastLine = 0, outputBytes = 0
  const scan = await scanLines(path, signal, {
    captureFrom: offset,
    stop(line) {
      if (line.number < offset) return
      const suffix = line.truncated ? ' [line preview truncated; use byte_offset for raw chunks]' : ''
      const rendered = line.text + suffix, cost = Buffer.byteLength(rendered) + 1
      if (lines.length && outputBytes + cost > MAX_OUTPUT_BYTES) return false
      lines.push(rendered); outputBytes += cost; lastLine = line.number
      if (lines.length >= limit) return false
    },
  })
  if (!lines.length && scan.totalLines < offset) throw Error(`Offset ${offset} is beyond the end of ${relativePath} (${scan.totalLines} lines scanned).`)
  const hasMore = scan.stopped || scan.bytesScanned < size
  const footer = hasMore ? `\n\n[Showing lines ${offset}-${lastLine}. Use offset=${lastLine + 1} to continue.]` : ''
  const details = { ok: true, path: relativePath, mode: 'content', bytes: size, offset, lines: lines.length, next_offset: hasMore ? lastLine + 1 : undefined, streaming: true }
  return { content: [{ type: 'text' as const, text: trimOutput(lines.join('\n') + footer) }], details }
}

async function readByteRange(path: string, relativePath: string, size: number, byteOffsetValue: unknown, maxBytes = MAX_OUTPUT_BYTES) {
  const byteOffset = clamp(byteOffsetValue, 0, 0, Math.max(0, size)), length = Math.min(maxBytes, Math.max(0, size - byteOffset))
  const buffer = Buffer.alloc(length), handle = await open(path, 'r')
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, byteOffset), next = byteOffset + bytesRead
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const footer = next < size ? `\n\n[Showing bytes ${byteOffset}-${next - 1}. Use byte_offset=${next} to continue.]` : ''
    const details = { ok: true, path: relativePath, mode: 'content', bytes: size, byte_offset: byteOffset, bytes_read: bytesRead, next_byte_offset: next < size ? next : undefined, streaming: true }
    return { content: [{ type: 'text' as const, text: trimOutput(text + footer) }], details }
  } finally { await handle.close() }
}

async function searchFile(path: string, relativePath: string, size: number, queryValue: unknown, caseSensitiveValue: unknown, maxMatchesValue: unknown, signal?: AbortSignal) {
  const query = String(queryValue || '')
  if (!query) throw Error('Search mode requires a non-empty query.')
  if (query.length > 4_096) throw Error('Search query is too long (maximum 4,096 characters).')
  const maxMatches = clamp(maxMatchesValue, 40, 1, 200), matches: ScannedLine[] = []
  let matchingLines = 0
  const scan = await scanLines(path, signal, {
    query, caseSensitive: caseSensitiveValue === true,
    stop(line) {
      if (!line.matched) return
      matchingLines++
      if (matches.length < maxMatches) matches.push(line)
    },
  })
  const body = matches.length
    ? matches.map(line => `${line.number}: ${line.text}${line.truncated ? ' [line preview truncated]' : ''}`).join('\n')
    : 'No matching lines.'
  const header = `[${matchingLines} matching line${matchingLines === 1 ? '' : 's'} in ${relativePath}; scanned ${scan.totalLines} lines / ${scan.bytesScanned} bytes]`
  const details = { ok: true, path: relativePath, mode: 'search', bytes: size, query, matching_lines: matchingLines, returned_matches: matches.length, lines_scanned: scan.totalLines, bytes_scanned: scan.bytesScanned, streaming: true }
  return { content: [{ type: 'text' as const, text: trimOutput(`${header}\n${body}`) }], details }
}

async function tailFile(path: string, relativePath: string, size: number, limitValue: unknown) {
  const limit = clamp(limitValue, 100, 1, 2_000), handle = await open(path, 'r'), chunks: Buffer[] = []
  let position = size, scanned = 0, newlines = 0
  try {
    while (position > 0 && scanned < MAX_TAIL_SCAN_BYTES && newlines <= limit) {
      const length = Math.min(STREAM_CHUNK_BYTES, position, MAX_TAIL_SCAN_BYTES - scanned), buffer = Buffer.alloc(length)
      position -= length
      const { bytesRead } = await handle.read(buffer, 0, length, position), chunk = buffer.subarray(0, bytesRead)
      chunks.unshift(chunk); scanned += bytesRead
      for (const byte of chunk) if (byte === 0x0a) newlines++
    }
  } finally { await handle.close() }
  const joined = Buffer.concat(chunks), text = joined.toString('utf8'), all = text.split(/\r?\n/)
  if (size > 0 && all.at(-1) === '') all.pop()
  const lines = all.slice(-limit), incomplete = position > 0 && newlines <= limit
  const details = { ok: true, path: relativePath, mode: 'tail', bytes: size, lines: lines.length, bytes_scanned: scanned, scan_limited: incomplete, streaming: true }
  const note = incomplete ? '\n[The final line exceeds the bounded 8 MB tail scan; use byte_offset for raw chunks.]' : ''
  return { content: [{ type: 'text' as const, text: trimOutput(lines.join('\n') + note) }], details }
}

async function overviewFile(path: string, relativePath: string, size: number, modified: number) {
  const head = await readByteRange(path, relativePath, size, 0, 8 * 1024), tail = await tailFile(path, relativePath, size, 40)
  const headText = head.content[0].text.replace(/\n\n\[Showing[\s\S]*$/, ''), tailText = tail.content[0].text
  const details = { ok: true, path: relativePath, mode: 'overview', bytes: size, modified_at: new Date(modified).toISOString(), streaming: true }
  return { content: [{ type: 'text' as const, text: trimOutput(`[File: ${relativePath}; ${size} bytes; modified ${new Date(modified).toISOString()}]\n\n--- head ---\n${headText}\n\n--- tail ---\n${tailText}`) }], details }
}

async function imageResult(relativePath: string, size: number, modified: number, mimeType: string, target: string): Promise<WorkspaceReadResult> {
  if (size > MAX_IMAGE_BYTES) throw Error(`Image is too large for visual reading (${Math.ceil(size / 1024 / 1024)} MB; limit 20 MB).`)
  const bytes = await readSmallFile(target, size)
  const metadata: AttachmentRef = {
    id: relativePath, taskId: 'workspace', name: relativePath.split('/').at(-1) || relativePath,
    kind: 'image', mimeType, size, sha256: `${size}-${modified}`, createdAt: modified,
    capabilities: { vision: true },
  }
  const preview = await previewAttachmentBytes(metadata, bytes, 1, 'model')
  if (preview.mode !== 'image') throw Error('Image did not produce visual content.')
  const details = { ok: true, path: relativePath, mode: 'visual', bytes: size, mimeType: preview.mimeType }
  return { content: [{ type: 'text', text: `Read image file [${preview.mimeType}] from ${relativePath}` }, { type: 'image', mimeType: preview.mimeType, data: preview.data }], details }
}

export async function readWorkspaceFile(workspace: string, pathValue: unknown, options: WorkspaceReadOptions = {}, signal?: AbortSignal): Promise<WorkspaceReadResult> {
  const path = await workspaceFilePath(workspace, pathValue), file = await stat(path.target)
  if (!file.isFile()) throw Error('Path must identify a file.')
  const sample = await sampleFile(path.target, file.size), mimeType = imageMime(sample)
  if (mimeType) return imageResult(path.relativePath, file.size, file.mtimeMs, mimeType, path.target)
  if (sample.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('Use read_pdf for semantic PDF reading; visual PDF rendering is not the default.')
  if (seemsBinary(sample)) throw Error('This file is binary or uses an unsupported text encoding. Use a format-aware workspace tool or a bounded streaming command; it will not be loaded into model context.')
  const mode = options.mode || 'content'
  if (mode === 'search') return searchFile(path.target, path.relativePath, file.size, options.query, options.caseSensitive, options.maxMatches, signal)
  if (mode === 'tail') return tailFile(path.target, path.relativePath, file.size, options.limit)
  if (mode === 'overview') return overviewFile(path.target, path.relativePath, file.size, file.mtimeMs)
  if (options.byteOffset !== undefined) return readByteRange(path.target, path.relativePath, file.size, options.byteOffset)
  if (!sample.includes(0x0a) && file.size > sample.length) {
    const offset = clamp(options.offset, 1, 1, Number.MAX_SAFE_INTEGER)
    if (offset === 1) return readByteRange(path.target, path.relativePath, file.size, 0)
    throw Error('The first line exceeds the 64 KB line-scan boundary. Use byte_offset for bounded raw continuation instead of a line offset.')
  }
  return readLineRange(path.target, path.relativePath, file.size, options.offset, options.limit, signal)
}

export function createWorkspaceReadTool(cwd: string): ToolDefinition {
  return defineTool({
    name: 'read', label: 'Read',
    description: 'Read local files through a bounded streaming boundary. Relative paths resolve from the task working directory; absolute paths are accepted with the permissions of the user running Shun. Text files are never loaded whole: use mode=overview for head/tail metadata, mode=content with offset/limit for line ranges, mode=tail for the end, or mode=search with query to scan even multi-gigabyte text using constant memory. Use byte_offset for efficient raw continuation or exceptionally long lines. Images return visual content within safety limits. Use read_pdf for semantic PDFs.',
    promptSnippet: 'Read local file contents, including very large text files',
    promptGuidelines: ['Use read instead of cat or sed. For large files, begin with overview or a targeted streaming search; do not place the whole file in model context.'],
    parameters: Type.Object({
      path: Type.String({ description: 'Path relative to the task working directory, or an absolute path' }),
      mode: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('overview'), Type.Literal('search'), Type.Literal('tail')])),
      offset: Type.Optional(Type.Integer({ minimum: 1, description: '1-indexed starting line for content mode' })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000, description: 'Maximum lines for content or tail mode' })),
      byte_offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Raw byte offset for bounded content reads' })),
      query: Type.Optional(Type.String({ maxLength: 4_096, description: 'Literal text to scan for in search mode' })),
      case_sensitive: Type.Optional(Type.Boolean()),
      max_matches: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }, { additionalProperties: false }),
    execute: async (_id, args, signal) => readWorkspaceFile(cwd, args.path, {
      mode: args.mode, offset: args.offset, limit: args.limit, byteOffset: args.byte_offset,
      query: args.query, caseSensitive: args.case_sensitive, maxMatches: args.max_matches,
    }, signal),
  })
}
