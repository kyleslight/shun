import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLedger, parsePlannedQueries, shortenQuery } from './bench-parse.mjs'

test('a plan arrives as JSON when the model cooperates, and as its own lines when it does not', () => {
  // A plan that fails to parse means the round never happens, which looks exactly like a round
  // that found nothing — so the lines the model wrote anyway are read too.
  assert.deepEqual(parsePlannedQueries('{"queries":[{"query":"Afrigo Band formed","goal":"find the band"}]}'), [
    { query: 'Afrigo Band formed', goal: 'find the band' },
  ])
  assert.deepEqual(parsePlannedQueries('Here is my plan:\nQuery: Lucha Underground episodes\nGoal: find the episode list\n- Query: Baron Corbin ring name\n- Goal: identify the wrestler'), [
    { query: 'Lucha Underground episodes', goal: 'find the episode list' },
    { query: 'Baron Corbin ring name', goal: 'identify the wrestler' },
  ])
  assert.deepEqual(parsePlannedQueries('no plan here'), [])
})

test('the ledger is read from headings, and from the lines written without them', () => {
  const headings = parseLedger('ESTABLISHED:\n- The show aired in 2015 [source: https://a]\nCANDIDATES:\n- Lucha Underground [source: https://b]\nOPEN:\n- Which episode opened with three matches')
  assert.match(headings.established, /aired in 2015/)
  assert.match(headings.candidates, /Lucha Underground/)
  assert.match(headings.open, /which episode opened/i)

  // Bold headings and an empty section still parse; a bare ledger stays empty rather than throwing.
  const bold = parseLedger('**ESTABLISHED:**\n- one fact\n**OPEN:**\n- one question')
  assert.match(bold.established, /one fact/)
  assert.match(bold.open, /one question/)
  assert.deepEqual(parseLedger('nothing structured'), { established: '', candidates: '', open: '' })
})

test('a query longer than a handful of words is shortened to the words a page would carry', () => {
  assert.equal(shortenQuery('wrestler named after a famous landmark defeated by a king gimmick AEW Dark episode'), 'wrestler named after a famous landmark')
  assert.equal(shortenQuery('Lucha Underground season 2'), 'Lucha Underground season 2')
  assert.equal(shortenQuery(''), '')
})
