import assert from 'node:assert/strict'
import { app, BrowserWindow } from 'electron'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPresentation } from '../src/main/presentation.ts'
import { renderPresentationSlide } from '../src/main/presentation-render.ts'

app.on('window-all-closed', () => {})
void app.whenReady().then(async () => {
  app.dock?.hide()
  try {
    // A fresh desktop need not have python, node, brew, or an office renderer on PATH.
    process.env.PATH = ''
    const root = await mkdtemp(join(tmpdir(), 'shun-presentation-smoke-'))
    const source = join(root, 'source.json')
    await writeFile(source, JSON.stringify({ title: 'Worldline · 支付概览', slides: [
      { background: '10243A', elements: [
        { type: 'rect', x: 0.6, y: 0.7, w: 0.12, h: 1.1, fill: '00C5BB' },
        { type: 'text', x: 1, y: 0.8, w: 11, h: 0.8, text: 'Worldline · 支付概览', fontSize: 36, bold: true, color: 'FFFFFF' },
        { type: 'text', x: 1, y: 2, w: 10.5, h: 3, text: '商户服务与支付解决方案\n中文、English & Unicode ✓', fontSize: 26, color: 'DCE5EE' },
        { type: 'ellipse', x: 10.5, y: 5, w: 1, h: 1, fill: '00C5BB' },
      ] },
      { elements: [{ type: 'text', x: 1, y: 1, w: 2, h: 0.2, text: 'Overflow validation '.repeat(20), fontSize: 30 }] },
    ] }))
    const result = await createPresentation(source, join(root, 'deck.pptx'), renderPresentationSlide)
    assert.equal(result.slides, 2)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /Slide 2/)
    for (const preview of result.previews) {
      const png = await readFile(preview)
      assert.equal(png.readUInt32BE(16), 1280)
      assert.equal(png.readUInt32BE(20), 720)
      assert.ok(png.length > 2000)
    }
    const controller = new AbortController()
    const cancelled = renderPresentationSlide('<!doctype html><body>Cancelled</body>', controller.signal)
    controller.abort()
    await assert.rejects(cancelled, /abort/i)
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    console.log(JSON.stringify({ status: 'passed', ...result }))
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
})
