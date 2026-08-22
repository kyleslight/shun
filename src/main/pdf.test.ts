import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pdfReadCharacterLimit, pdfReadCharacterOffset, readWorkspacePdf, workspacePdfPath } from './pdf.ts'
import { readPdfBytes, type PdfParser } from './pdf-reader.ts'

function minimalPdf(lines: string[]) {
  const escaped = lines.map(line => line.replace(/([\\()])/g, '\\$1'))
  const operations = ['BT', '/F1 12 Tf', '72 720 Td', ...escaped.flatMap((line, index) => [index ? '0 -20 Td' : '', `(${line}) Tj`]).filter(Boolean), 'ET'].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(operations)} >>\nstream\n${operations}\nendstream`,
  ]
  let output = '%PDF-1.4\n', offset = Buffer.byteLength(output)
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(offset)
    const entry = `${index + 1} 0 obj\n${object}\nendobj\n`
    output += entry
    offset += Buffer.byteLength(entry)
  })
  const xref = offset
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => `${String(value).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output)
}

test('local PDF reading is built in, page-aware, searchable, and bounded', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-pdf-test-'))
  await writeFile(join(workspace, 'general-document.pdf'), minimalPdf(['Universal PDF document', 'Section total USD 42.50']))

  const parsed = JSON.parse(await readWorkspacePdf(workspace, 'general-document.pdf', { query: 'Section total', maxChars: 2_000 }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.parser, 'pdfjs')
  assert.equal(parsed.pages, 1)
  assert.equal(parsed.text_layer, true)
  assert.deepEqual(parsed.matched_pages, [1])
  assert.match(parsed.content, /--- Page 1 ---[\s\S]*Section total USD 42\.50/)
})

test('local PDF paths cannot escape the selected workspace', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-pdf-scope-'))
  await assert.rejects(workspacePdfPath(workspace, '../outside.pdf'), /escapes the selected workspace/)
})

test('image-only PDFs report the missing text layer instead of inventing content', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'shun-pdf-image-'))
  await writeFile(join(workspace, 'scan.pdf'), minimalPdf([]))
  const parsed = JSON.parse(await readWorkspacePdf(workspace, 'scan.pdf', { query: 'anything' }))
  assert.equal(parsed.text_layer, false)
  assert.match(parsed.warning, /scanned or image-only/)
  assert.doesNotMatch(parsed.content, /anything/)
})

test('local PDF reads use stable context limits on every platform', () => {
  assert.equal(pdfReadCharacterLimit(undefined), 12_000)
  assert.equal(pdfReadCharacterLimit(100), 1_000)
  assert.equal(pdfReadCharacterLimit(99_000), 20_000)
  assert.equal(pdfReadCharacterOffset(-1), 0)
  assert.equal(pdfReadCharacterOffset(600_000), 600_000)
})

test('the PDF tool protocol is independent from the parser implementation', async () => {
  const rustCandidate: PdfParser = {
    id: 'rust-candidate',
    read: async (_bytes, options) => ({ pages: 1, content: `limit:${options.maxChars}` }),
  }
  const result = await readPdfBytes(Buffer.from('%PDF-1.4'), { maxChars: 4_000, offset: 0 }, rustCandidate)
  assert.deepEqual(result, { parser: 'rust-candidate', pages: 1, content: 'limit:4000' })
})
