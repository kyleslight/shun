import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserBrowserSearch, parseUserBrowserResults, type ChromeSearchSnapshot } from './user-browser-search.ts'

const snapshot = (nodes: Array<Record<string, unknown>>): ChromeSearchSnapshot => ({
  tab: { url: 'https://www.google.com/search?q=x', title: 'x - Google 搜索' },
  // A rendered result page: the real one arrives complete, with a tree rather than a single root.
  readyState: 'complete',
  nodes: [...Array.from({ length: 24 }, () => ({ role: 'generic', name: '' })), ...nodes],
})

test('a result page read from the user’s Chrome becomes results with their addresses', () => {
  // An engine's accessible name for a result is the title, the site, and the address; the address
  // is the part that can be opened, and the title is what precedes it.
  const parsed = parseUserBrowserResults(snapshot([
    { role: 'link', name: 'Afrigo Band - Wikipedia https://en.wikipedia.org › wiki › Afrigo_Band · 翻译此页' },
    { role: 'link', name: 'stovaris.lt https://stovaris.lt › story › 1419700' },
    { role: 'heading', name: 'Web results' },
    // The engine's own pages are not results.
    { role: 'link', name: 'Google 首页 https://www.google.com/' },
    { role: 'link', name: 'duplicate https://en.wikipedia.org › wiki › Afrigo_Band' },
  ]), 'google')

  // Two results: the engine's own page is not a result, and the second spelling of the same address
  // is the same result.
  assert.equal(parsed.length, 2)
  // The engine states the address in parts; the parts are joined back so the result points at the
  // page rather than at the site root.
  assert.equal(parsed[0].url, 'https://en.wikipedia.org/wiki/Afrigo_Band')
  assert.match(parsed[0].title, /Afrigo Band/)
  assert.equal(parsed[0].engine, 'user-browser:google')
  assert.equal(parsed[1].url, 'https://stovaris.lt/story/1419700')
})

test('a result without an address is not a result', () => {
  const parsed = parseUserBrowserResults(snapshot([
    { role: 'link', name: 'Something with no address at all' },
    { role: 'link', name: 'Address in the description', description: 'https://example.test/page' },
  ]), 'bing')
  assert.deepEqual(parsed.map(row => row.url), ['https://example.test/page'])
})

test('a fallback search closes the tab it opened', async () => {
  const opened: string[] = [], closed: string[] = []
  const search = createUserBrowserSearch({
    openTab: async url => {
      opened.push(url)
      return { sessionId: 'session-1', snapshot: snapshot([{ role: 'link', name: 'Afrigo Band page https://example.test/a' }]) }
    },
    snapshot: async () => snapshot([]),
    closeTab: async id => { closed.push(id) },
  })
  const results = await search('afrigo band formed 1975', 5)
  assert.equal(results.length, 1)
  // The strongest index is asked first, whatever language the question is in.
  assert.match(opened[0], /^https:\/\/www\.google\.com\/search\?q=afrigo/)
  assert.deepEqual(closed, ['session-1'])

  // A failing search still closes the tab it opened.
  const failing = createUserBrowserSearch({
    openTab: async () => { throw Error('Chrome is not connected') },
    snapshot: async () => snapshot([]),
    closeTab: async id => { closed.push(id) },
  })
  await assert.rejects(() => failing('query', 5), /not connected/)
  assert.deepEqual(closed, ['session-1'])
})

test('a page that answered a different question is not a result set', () => {
  // An engine can answer a query with a plausible page about something else rather than refusing it;
  // reporting that as results for this query would be worse than reporting nothing.
  const unrelated = parseUserBrowserResults(snapshot([
    { role: 'link', name: 'Math Calculator' },
    { role: 'StaticText', name: 'https://www.calculatorsoup.com' },
    { role: 'StaticText', name: '› calculators › math › math.php' },
  ]), 'bing', 8, 'Afrigo Band formed 1975 eight musicians')
  assert.deepEqual(unrelated, [])

  // A page that does answer it keeps its results, with the address taken from the node beside the
  // title, which is where an engine states it.
  const related = parseUserBrowserResults(snapshot([
    { role: 'link', name: 'Afrigo Band - Wikipedia' },
    { role: 'StaticText', name: 'https://en.wikipedia.org' },
    { role: 'StaticText', name: '› wiki › Afrigo_Band' },
  ]), 'bing', 8, 'Afrigo Band formed 1975 eight musicians')
  assert.deepEqual(related.map(row => row.url), ['https://en.wikipedia.org/wiki/Afrigo_Band'])
  assert.equal(related[0].title, 'Afrigo Band - Wikipedia')
})
