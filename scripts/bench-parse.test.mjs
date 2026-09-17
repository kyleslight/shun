import assert from 'node:assert/strict'
import test from 'node:test'
import { chooseStableAnswer, parseLedger, parsePlannedQueries, shortenQuery } from './bench-parse.mjs'

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

test('the reported answer is the one the pages support, chosen the same way every time', () => {
  const evidence = ['Lucha Underground episode list: Season 2 Episode 4 is titled Cero Miedo and opened with three matches.']
  // The model's own answer is kept when the pages state it.
  assert.deepEqual(chooseStableAnswer({ answer: 'Cero Miedo', candidates: '', evidence }), { answer: 'Cero Miedo', source: 'model' })
  // A fragment is replaced by the candidate the ledger recorded and the pages contain.
  assert.deepEqual(chooseStableAnswer({ answer: '. Hmm', candidates: '- Cero Miedo [source: https://a]\n- A rival episode', evidence }), { answer: 'Cero Miedo', source: 'ledger-candidate' })
  // A name nothing states is not reported as a finding.
  const unsupported = chooseStableAnswer({ answer: 'Flora of Niue', candidates: '', evidence })
  assert.equal(unsupported.answer, 'Flora of Niue')
  assert.equal(unsupported.source, 'model-unsupported')
  // Nothing at all reports nothing, rather than an empty string dressed as an answer.
  assert.deepEqual(chooseStableAnswer({ answer: '', candidates: '', evidence }), { answer: '', source: 'none' })
})
