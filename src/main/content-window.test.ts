import assert from 'node:assert/strict'
import test from 'node:test'
import { queryWindow } from './content-window.ts'

test('a complete answer section replaces unrelated padding without rewriting evidence', () => {
  const section = '## Concurrency\n\n' + 'Readers can proceed concurrently. There can only be one writer at a time. '.repeat(5) + '\n\n'
  const document = '# Storage manual\n\n' + 'Introduction and navigation. '.repeat(180) + '\n\n' + section + '## Maintenance\n\n' + 'Unrelated implementation background. '.repeat(180)
  const result = queryWindow(document, 'writer concurrency readers', 3000, 0, {title:'Storage manual'})
  assert.equal(result.section_complete, true)
  assert.equal(result.content, section)
  assert.equal(result.content, document.slice(result.content_offset, result.content_end))
  assert.deepEqual(result.section_path, ['Storage manual', 'Concurrency'])
  assert.ok(result.returned_characters < 600)
})

test('section focusing does not discard another requested detail or nested qualifications', () => {
  const document = '# Policy\n\n' + 'Background. '.repeat(200) + '\n\n## Eligibility\n\n' + 'Enrollment covers visitors. '.repeat(12) + '\n\n### Exclusions\n\n' + 'International applicants are excluded. '.repeat(10) + '\n\n## Cost\n\n' + 'Tuition costs differ by year. '.repeat(10) + '\n\n## Footer\n\n' + 'Links and navigation. '.repeat(200)
  const eligibility = queryWindow(document, 'enrollment international', 3000, 0)
  assert.ok(eligibility.content.includes('International applicants are excluded.'))
  const both = queryWindow(document, 'enrollment tuition', 3000, 0)
  assert.ok(both.content.includes('Enrollment covers visitors.'))
  assert.ok(both.content.includes('Tuition costs differ by year.'))
})

test('dense citation titles do not displace the answer in article prose', () => {
  const answer = '## Availability\n\nThe release date is November 24, 2031. Availability remains subject to regional scheduling.\n\n'
  const document = '# Example film\n\n' + 'Cast and production background. '.repeat(160) + '\n\n' + answer
    + 'Other production notes. '.repeat(100) + '\n\n'
    + Array.from({ length: 40 }, (_, i) => `[^${i}]: A reporter. "November release date update ${i}". A journal. Retrieved November 20, 2031.\n\n`).join('')
  const result = queryWindow(document, 'release date November 2031', 1500, 0, { title: 'Example film' })
  assert.ok(result.content.includes('The release date is November 24, 2031.'))
  assert.equal(result.content, document.slice(result.content_offset, result.content_end))
})

test('a detail found only in a citation remains retrievable', () => {
  const document = '# Example study\n\n' + 'Study background. '.repeat(300) + '\n\n'
    + '[^source]: Report by SpecialAuthor about the benchmark methodology.\n  Continued publication details.\n\n'
    + 'Unrelated references. '.repeat(100)
  const result = queryWindow(document, 'SpecialAuthor methodology', 1000, 0)
  assert.ok(result.content.includes('SpecialAuthor'))
  assert.ok(result.content.includes('Continued publication details.'))
  assert.equal(result.content, document.slice(result.content_offset, result.content_end))
})

test('an explicit later offset can still inspect a reference list', () => {
  const introduction = 'Release date November 24, 2031.\n\n' + 'Background. '.repeat(200) + '\n\n'
  const citations = Array.from({ length: 24 }, (_, i) => `[^${i}]: November release date report ${i}.\n\n`).join('')
  const document = introduction + citations
  const result = queryWindow(document, 'release date November', 500, introduction.length)
  assert.ok(result.content.includes('report'))
  assert.ok(result.content_offset >= introduction.length)
})
