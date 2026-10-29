import assert from 'node:assert/strict'
import test from 'node:test'
import { markdownAllowedUri } from '../renderer/src/markdown-links.ts'

test('delivered file links retain relative, absolute and encoded local destinations', () => {
  for (const href of [
    'stories/relativity-gps/out/relativity-gps-v2.mp4',
    'stories/relativity-gps/out/relativity-gps-v2-script.md',
    'stories/relativity-gps/out/relativity-gps-v2.srt',
    'report2.pdf', './out/report.pdf', '../report.pdf', '/Users/name/report.pdf',
    'file:///Users/name/My%20Project/report.pdf',
    'https://example.com/report', 'shun://task/abc-123',
  ]) assert.equal(markdownAllowedUri.test(href), true, href)
})

test('executable and unknown URL schemes are not accepted as file links', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'vbscript:msgbox(1)', 'custom:payload']) {
    assert.equal(markdownAllowedUri.test(href), false, href)
  }
})
