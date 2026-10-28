import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { unzipSync, strFromU8 } from 'fflate'
import { createPresentation, presentationSlideHtml, validatePresentation } from './presentation.ts'

const spec = () => ({ title: '演示 <test>', slides: [{ background: '10243A', elements: [
  { type: 'rect', x: 1, y: 1, w: 4, h: 1, fill: '00C5BB' },
  { type: 'text', x: 1, y: 1, w: 4, h: 1, text: 'Worldline 支付 & <script>alert(1)</script>', fontSize: 24, color: 'FFFFFF' },
  { type: 'ellipse', x: 7, y: 2, w: 1, h: 1, fill: '00C5BB' },
] }] })

test('bundled exporter creates editable slides and bounded source previews without external commands', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-presentation-'))
  const input = join(root, 'source.json'), output = join(root, 'deck.pptx')
  await writeFile(input, JSON.stringify(spec()))
  let rendered = 0
  const result = await createPresentation(input, output, async html => {
    rendered++
    assert.match(html, /Worldline 支付 &amp; &lt;script&gt;/)
    assert.doesNotMatch(html, /<script>/)
    return { png: new Uint8Array([1, 2, 3]), overflowingText: 1 }
  })
  assert.equal(rendered, 1)
  assert.equal(result.previews.length, 1)
  assert.match(result.warnings[0], /Slide 1.*overflow/)
  const zip = unzipSync(await readFile(output))
  const xml = strFromU8(zip['ppt/slides/slide1.xml'])
  assert.match(xml, /Worldline 支付 &amp; &lt;script&gt;/)
  assert.match(xml, /prst="ellipse"/)
  assert.equal((xml.match(/<p:sp>/g) || []).length, 3)
  // Revisions read the current source rather than retaining a startup snapshot.
  const revision = spec(); revision.slides.push(revision.slides[0])
  await writeFile(input, JSON.stringify(revision))
  assert.equal((await createPresentation(input, output, async () => ({ png: new Uint8Array([1]), overflowingText: 0 }))).slides, 2)
})

test('invalid slide geometry and unsupported content fail before output is produced', () => {
  const source = spec()
  source.slides[0].elements[0].x = 13
  assert.throws(() => validatePresentation(source), /outside/)
  source.slides[0].elements[0].x = 1
  source.slides[0].elements[0].type = 'table'
  assert.throws(() => validatePresentation(source), /Unsupported/)
  assert.throws(() => validatePresentation({ title: 'Empty', slides: [] }), /1–60/)
  assert.throws(() => validatePresentation({ ...spec(), fontFace: 42 }), /fontFace/)
  assert.throws(() => validatePresentation({ ...spec(), images: [] }), /Unsupported.*images/)
})

test('render failures and cancellation remain failures and do not replace the existing deck', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shun-presentation-failure-'))
  const input = join(root, 'source.json'), output = join(root, 'deck.pptx')
  await writeFile(input, JSON.stringify(spec())); await writeFile(output, 'existing')
  await assert.rejects(createPresentation(input, output, async () => { throw Error('renderer unavailable') }), /renderer unavailable/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(createPresentation(input, output, async () => { throw Error('must not render') }, controller.signal), /abort/i)
  assert.equal(await readFile(output, 'utf8'), 'existing')
})

test('source preview encodes untrusted text and excludes external resource loading', () => {
  const html = presentationSlideHtml(validatePresentation(spec()), 0)
  assert.match(html, /default-src 'none'/)
  assert.doesNotMatch(html, /<script>/)
})
