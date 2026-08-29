import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { renderPluginWorkspacePdf } from './plugin-workspace-pdf.ts'

function onePagePdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ]
  let text = '%PDF-1.4\n', offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(text))
    text += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(text)
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Root 1 0 R /Size 5 >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(text)
}

test('workspace PDF preview renders one bounded page and reuses the page cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-plugin-pdf-'))
  await writeFile(join(root, 'sample.pdf'), onePagePdf())
  const first = await renderPluginWorkspacePdf(root, { path: 'sample.pdf', page: 1, maxDimension: 800 })
  const second = await renderPluginWorkspacePdf(root, { path: 'sample.pdf', page: 1, maxDimension: 800 })
  assert.deepEqual({ mimeType: first.mimeType, width: first.width, height: first.height, page: first.page, pages: first.pages }, { mimeType: 'image/png', width: 500, height: 250, page: 1, pages: 1 })
  assert.match(Buffer.from(first.data, 'base64').subarray(1, 4).toString(), /PNG/)
  assert.equal(second.data, first.data)
  await assert.rejects(renderPluginWorkspacePdf(root, { path: '../sample.pdf' }), /escapes|ENOENT/)
})
