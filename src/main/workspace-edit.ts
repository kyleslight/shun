import { constants } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import { createEditToolDefinition, withFileMutationQueue, type EditToolInput, type ToolDefinition } from '@earendil-works/pi-coding-agent'

type WorkspaceEdit = { oldText: string; newText: string }
type MatchedEdit = { index: number; start: number; end: number; newText: string }

function normalizedLineEndings(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function lineEnding(value: string) {
  return value.includes('\r\n') ? '\r\n' : '\n'
}

function restoreLineEndings(value: string, ending: string) {
  return ending === '\r\n' ? value.replace(/\n/g, '\r\n') : value
}

function occurrences(content: string, value: string) {
  if (!value) return []
  const indexes: number[] = []
  for (let offset = 0; offset <= content.length - value.length;) {
    const index = content.indexOf(value, offset)
    if (index < 0) break
    indexes.push(index)
    offset = index + Math.max(1, value.length)
  }
  return indexes
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function whitespaceFlexibleMatches(content: string, oldText: string) {
  const parts = oldText.split(/(\s+)/).filter(Boolean)
  if (!parts.some(part => !/^\s+$/.test(part))) return []
  const pattern = parts.map(part => /^\s+$/.test(part) ? '\\s+?' : escaped(part)).join('')
  let expression: RegExp
  try { expression = new RegExp(pattern, 'gu') } catch { return [] }
  return [...content.matchAll(expression)].map(match => ({ start: match.index, end: match.index + match[0].length }))
}

function alreadyPresent(content: string, edit: WorkspaceEdit) {
  if (edit.oldText === edit.newText) return true
  if (!edit.newText) return false
  return occurrences(content, edit.oldText).length === 0 && occurrences(content, edit.newText).length === 1
}

function matchEdits(content: string, edits: WorkspaceEdit[], path: string) {
  const matched: MatchedEdit[] = [], alreadyApplied: number[] = []
  for (let index = 0; index < edits.length; index++) {
    const edit = { oldText: normalizedLineEndings(edits[index].oldText), newText: normalizedLineEndings(edits[index].newText) }
    if (!edit.oldText) throw Error(`edits[${index}].oldText must not be empty in ${path}.`)
    if (alreadyPresent(content, edit)) { alreadyApplied.push(index); continue }
    const exact = occurrences(content, edit.oldText)
    if (exact.length === 1) {
      matched.push({ index, start: exact[0], end: exact[0] + edit.oldText.length, newText: edit.newText })
      continue
    }
    if (exact.length > 1) throw Error(`edits[${index}] is ambiguous in ${path}; its current text occurs ${exact.length} times. Add a small unique anchor and keep it in this same one-shot batch.`)
    const flexible = whitespaceFlexibleMatches(content, edit.oldText)
    if (flexible.length === 1) {
      matched.push({ index, start: flexible[0].start, end: flexible[0].end, newText: edit.newText })
      continue
    }
    if (flexible.length > 1) throw Error(`edits[${index}] is ambiguous in ${path} after whitespace normalization. Add a small unique anchor and keep it in this same one-shot batch.`)
    throw Error(`edits[${index}] no longer identifies current text in ${path}. Re-read one narrow range containing that target, then resend the complete remaining file change in one edit call.`)
  }
  matched.sort((a, b) => a.start - b.start)
  for (let index = 1; index < matched.length; index++) {
    if (matched[index - 1].end > matched[index].start) throw Error(`edits[${matched[index - 1].index}] and edits[${matched[index].index}] overlap in ${path}. Merge only those neighboring replacements and keep the rest in this same call.`)
  }
  return { matched, alreadyApplied }
}

function applyMatchedEdits(content: string, edits: MatchedEdit[]) {
  let next = content
  for (const edit of [...edits].reverse()) next = next.slice(0, edit.start) + edit.newText + next.slice(edit.end)
  return next
}

function displayPath(cwd: string, target: string) {
  const rel = relative(resolve(cwd), target)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.split(sep).join('/') : target.split(sep).join('/')
}

function firstChangedLine(before: string, after: string) {
  const beforeLines = before.split('\n'), afterLines = after.split('\n'), count = Math.max(beforeLines.length, afterLines.length)
  for (let index = 0; index < count; index++) if (beforeLines[index] !== afterLines[index]) return index + 1
  return undefined
}

export async function editWorkspaceFile(cwd: string, pathValue: unknown, edits: WorkspaceEdit[], signal?: AbortSignal) {
  const requested = String(pathValue || '').trim()
  if (!requested) throw Error('File path is required.')
  const target = resolve(cwd, requested), path = displayPath(cwd, target)
  return withFileMutationQueue(target, async () => {
    const abort = () => { if (signal?.aborted) throw Error('Operation aborted') }
    abort()
    await access(target, constants.R_OK | constants.W_OK)
    abort()
    const raw = await readFile(target, 'utf8'), bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '', withoutBom = bom ? raw.slice(1) : raw
    const ending = lineEnding(withoutBom), content = normalizedLineEndings(withoutBom)
    const { matched, alreadyApplied } = matchEdits(content, edits, path)
    const next = applyMatchedEdits(content, matched)
    if (next === content) return {
      content: [{ type: 'text' as const, text: `All ${edits.length} requested replacement(s) are already present in ${path}; no additional write was needed.` }],
      details: { changed: false, path, applied: 0, alreadyApplied: alreadyApplied.length },
    }
    abort()
    await writeFile(target, bom + restoreLineEndings(next, ending), 'utf8')
    abort()
    const patch = createTwoFilesPatch(path, path, content, next, undefined, undefined, { context: 4 })
    return {
      content: [{ type: 'text' as const, text: `Applied ${matched.length} replacement(s) to ${path} in one atomic batch${alreadyApplied.length ? `; ${alreadyApplied.length} requested replacement(s) were already present` : ''}.` }],
      details: { changed: true, path, applied: matched.length, alreadyApplied: alreadyApplied.length, patch, diff: patch, firstChangedLine: firstChangedLine(content, next) },
    }
  })
}

export function createWorkspaceEditTool(cwd: string): ToolDefinition {
  const base = createEditToolDefinition(cwd)
  return {
    ...base,
    label: 'Edit file',
    description: `${base.description} The batch is idempotent for already-present replacements and tolerates ordinary whitespace-only drift.`,
    promptGuidelines: [
      ...(base.promptGuidelines || []),
      'For one requested change to one file, use exactly one edit call containing the complete coherent edits[] batch.',
      'Do not divide edits into first/second/third batches and do not run shell commands merely to inventory which replacements remain.',
      'All replacements are matched against one current file snapshot. Neighboring or overlapping changes should be merged into one edits[] entry; independent regions stay as separate entries in the same call.',
      'A successful result reports replacements that were already present, so never retry those separately.',
    ],
    execute: async (_id, args: EditToolInput, signal) => editWorkspaceFile(cwd, args.path, args.edits, signal),
  } as ToolDefinition
}
