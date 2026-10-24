import assert from 'node:assert/strict'
import test from 'node:test'
import { queryWindow, jsonRecordWindow } from './content-window.ts'

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

test('short numeric limits keep a plan comparison ahead of a repetitive FAQ', () => {
  const comparison = '## Plan comparison\n\nFree\n\nExternal guest limit\n\n10\n\nUnlimited guests\n\nUnlimited guests\n\n'
  const document = '# Example plans\n\n' + comparison + 'Other feature descriptions. '.repeat(250)
    + '\n\n## Questions\n\n' + 'Free plan members can add guests. A member pays for an upgraded plan. '.repeat(40)
  const result = queryWindow(document, 'Free plan members guests limit 10 guests', 1700, 0)
  assert.ok(result.content.includes('External guest limit\n\n10'))
  assert.equal(result.content, document.slice(result.content_offset, result.content_end))
})

test('plural query terms can locate singular field labels', () => {
  const document = '# Example plans\n\n' + 'Navigation. '.repeat(200)
    + '\n\n## Limits\n\nGuest capacity is ten for this plan.\n\n' + 'Other details. '.repeat(200)
    + '\n\n## Questions\n\n' + 'Guests are external collaborators. '.repeat(60)
  const result = queryWindow(document, 'guests capacity', 700, 0)
  assert.ok(result.content.includes('Guest capacity is ten'))
})

test('a scalar comparison field outranks a repetitive FAQ without a guessed numeric query', () => {
  const comparison = '## Plan comparison\n\nFree\n\nExternal guest limit\n\n10\n\nUnlimited guests\n\nUnlimited guests\n\n'
  const document = '# Example plans\n\n' + comparison + 'Other feature descriptions. '.repeat(250)
    + '\n\n## Questions\n\n' + 'Free plan members can add guests. A member pays for an upgraded plan. '.repeat(40)
  const result = queryWindow(document, 'free plan members guests limit', 1700, 0)
  assert.ok(result.content.includes('External guest limit\n\n10'))
  assert.equal(result.content, document.slice(result.content_offset, result.content_end))
})

test('query words in link destinations do not displace explanatory source prose', () => {
  const background = '## Administration\n\n' + 'Manage users through [settings](https://example.test/docs/accounts). '.repeat(35)
  const answer = '## Guest accounts\n\nGuest accounts require an upgraded plan. They have restricted access.\n\n'
  const document = background + 'Other administrative details. '.repeat(100) + '\n\n' + answer + '## Footer\n\n' + 'Other links. '.repeat(100)
  const result = queryWindow(document, 'docs guest accounts plan', 1200, 0, {title:'Administration'})
  assert.ok(result.content.includes('Guest accounts require an upgraded plan.'))
  assert.equal(result.content, document.slice(result.content_offset, result.content_end))
})


test('JSON selectors keep source order when only schema names and repeated values match', () => {
  const document=JSON.stringify(Array.from({length:80},(_,i)=>({version:`v${80-i}.0.0`,date:'2031-10-20',files:['package-a','package-b'],lts:false,security:false})))
  const result=jsonRecordWindow(document,'latest current release version lts false',180,0)!
  assert.equal(result.json_record?.index,0)
  assert.ok(result.content.includes('v80.0.0'))
  assert.equal(result.content,document.slice(result.content_offset,result.content_end))
})

test('JSON record matching preserves exact source values and explicit character offsets', () => {
  const document='[{"version":"v2.0.0","identifier":900719925474099312345},{"version":"v1.0.0","note":"brace } and comma , inside a string"}]'
  const result=jsonRecordWindow(document,'v1.0.0',60,0)!
  assert.equal(result.json_record?.index,1)
  assert.equal(result.content,document.slice(result.content_offset,result.content_end))
  const first=jsonRecordWindow(document,'identifier',60,0)!
  assert.ok(first.content.includes('900719925474099312345'))
  const next=jsonRecordWindow(document,'version',40,first.content_end)!
  assert.equal(next.content_offset,first.content_end)
  assert.equal(jsonRecordWindow('[malformed','query',20,0),undefined)
})
