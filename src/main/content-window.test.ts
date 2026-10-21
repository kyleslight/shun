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
