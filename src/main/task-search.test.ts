import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import type { Task } from '../shared.ts'
import { clearTaskSearchIndex, taskSearchIndexSize, taskSearchMatches, taskSearchSnippet, taskSearchText } from '../renderer/src/task-search.ts'

function task(overrides: Partial<Task> & { id: string }): Task {
  return { title: 'Untitled', workspace: '/code/shun', turns: [], createdAt: 1, updatedAt: 1, ...overrides }
}

function userTurn(id: string, content: string, at = 1) {
  return { id, role: 'user' as const, content, startedAt: at }
}

test('a task whose body mentions the term is found even when its title does not', () => {
  const tasks = [
    task({ id: 'a', title: 'Untitled', workspace: '/code/shun', updatedAt: 30, turns: [userTurn('t1', 'the frobnicator API needs a backwards compatible shim')] }),
    task({ id: 'b', title: 'Palette polish', workspace: '/code/shun', updatedAt: 10, turns: [userTurn('t2', 'align the spacing')] }),
  ]
  assert.deepEqual(taskSearchMatches(tasks, 'frobnicator', {}).map(item => item.task.id), ['a'])
  assert.deepEqual(taskSearchMatches(tasks, 'frobnicator API', {}).map(item => item.task.id), ['a'])
})

test('title and project matches rank above body matches, then recency decides', () => {
  const tasks = [
    task({ id: 'body', title: 'Untitled', workspace: '/code/shun', updatedAt: 99, turns: [userTurn('t1', 'we discussed the frobnicator shim')] }),
    task({ id: 'old-title', title: 'Frobnicator migration', workspace: '/code/shun', updatedAt: 10, turns: [userTurn('t2', 'x')] }),
    task({ id: 'new-title', title: 'Frobnicator rollout', workspace: '/code/shun', updatedAt: 20, turns: [userTurn('t3', 'x')] }),
    task({ id: 'project', title: 'Untitled', workspace: '/code/frobnicator', updatedAt: 5, turns: [userTurn('t4', 'x')] }),
  ]
  assert.deepEqual(taskSearchMatches(tasks, 'frobnicator', {}).map(item => item.task.id), ['new-title', 'old-title', 'project', 'body'])
})

test('assistant notes and tool output are searchable, case-insensitively', () => {
  const tasks = [task({
    id: 'a',
    turns: [{
      id: 't1', role: 'assistant', content: 'done', timeline: [
        { type: 'text', text: 'Switched the loader to REGEX parsing' },
        { type: 'tool', tool: { id: 'c1', name: 'bash', input: 'rg -n needle', output: 'src/Needle.ts:12: export const needle', state: 'done' } },
      ],
    }],
  })]
  assert.deepEqual(taskSearchMatches(tasks, 'regex parsing', {}).map(item => item.task.id), ['a'])
  assert.deepEqual(taskSearchMatches(tasks, 'src/needle.ts', {}).map(item => item.task.id), ['a'])
})

test('archived tasks are never search results, even with an empty query', () => {
  const tasks = [
    task({ id: 'live', title: 'Live work', updatedAt: 10, turns: [userTurn('t1', 'x')] }),
    task({ id: 'archived', title: 'Archived work', archivedAt: 5, updatedAt: 20, turns: [userTurn('t2', 'x')] }),
  ]
  assert.deepEqual(taskSearchMatches(tasks, '', {}).map(item => item.task.id), ['live'])
  assert.deepEqual(taskSearchMatches(tasks, 'archived work', {}).map(item => item.task.id), [])
})

test('a title-only hit never indexes task bodies, and the index empties when the palette closes', () => {
  const tasks = Array.from({ length: 9 }, (_, index) => task({
    id: `t${index}`,
    title: `Needle ${index}`,
    updatedAt: 100 - index,
    turns: [userTurn('x', 'body text')],
  }))
  clearTaskSearchIndex()
  assert.equal(taskSearchMatches(tasks, 'needle', {}).length, 9)
  assert.equal(taskSearchIndexSize(), 0)
  // Only a body match pays for indexing, and every task holding the term is one.
  assert.equal(taskSearchMatches(tasks, 'body text', {}).length, 9)
  assert.equal(taskSearchIndexSize(), 9)
  clearTaskSearchIndex()
  assert.equal(taskSearchIndexSize(), 0)
})

test('a body match is quoted with its source, its term, and bounded surrounding context', () => {
  const long = `${'lead in '.repeat(40)}the frobnicator shim ships ${'tail '.repeat(40)}`
  const tasks = [task({
    id: 'quoted',
    updatedAt: 5,
    turns: [userTurn('t1', long), { id: 't2', role: 'assistant', content: 'unrelated', startedAt: 2 }],
  })]
  const [match] = taskSearchMatches(tasks, 'frobnicator', {})
  assert.equal(match.snippet?.kind, 'you')
  assert.equal(match.snippet?.match, 'frobnicator')
  const { before, after } = match.snippet!
  assert.match(before, /^…/)
  assert.match(after, /…$/)
  assert.match(before, /the $/)
  assert.match(after, /^ shim ships tail/)
  assert.ok(before.length + after.length + match.snippet!.match.length <= 124)
})

test('a tool match is quoted as the tool that produced it, preferring messages over tool dumps', () => {
  const toolTurn = {
    id: 't1', role: 'assistant' as const, content: 'ran the check', startedAt: 1,
    timeline: [{ type: 'tool' as const, tool: { id: 'c1', name: 'bash', input: 'grep frobnicator src/*', output: 'no match', state: 'done' as const } }],
  }
  const [onlyTool] = taskSearchMatches([task({ id: 'tool-only', turns: [toolTurn] })], 'grep frobnicator', {})
  assert.equal(onlyTool.snippet?.kind, 'tool')
  assert.equal(onlyTool.snippet?.name, 'bash')
  const [prefersMessage] = taskSearchMatches([task({ id: 'tool-with-message', turns: [userTurn('t0', 'the frobnicator is fine'), toolTurn] })], 'frobnicator', {})
  assert.equal(prefersMessage.snippet?.kind, 'you')
  assert.equal(prefersMessage.snippet?.match, 'frobnicator')
})

test('title matches carry no excerpt and a query never quotes the whole task', () => {
  const tasks = [task({ id: 'no-excerpt', title: 'Frobnicator rollout', turns: [userTurn('t1', 'x'.repeat(5_000))] })]
  assert.equal(taskSearchMatches(tasks, 'frobnicator', {})[0].snippet, undefined)
  const snippet = taskSearchSnippet(tasks[0], /x/)!
  assert.ok(snippet.before.length + snippet.match.length + snippet.after.length <= 124)
})

test('the index is reused while a task is unchanged and rebuilt when it changes', () => {
  const original = task({ id: 'rebuild', updatedAt: 1, turns: [userTurn('t1', 'first revision')] })
  clearTaskSearchIndex()
  assert.equal(taskSearchText(original), taskSearchText(original))
  const unchanged = task({ id: 'rebuild', updatedAt: 1, turns: [userTurn('t1', 'first revision')] })
  assert.equal(taskSearchText(unchanged), taskSearchText(original))
  const edited = task({ id: 'rebuild', updatedAt: 2, turns: [userTurn('t1', 'second revision')] })
  assert.match(taskSearchText(edited), /second revision/)
  // Closing the palette drops retained text, so nothing stale survives it.
  const replaced = task({ id: 'rebuild', updatedAt: 2, turns: [userTurn('t1', 'third revision')] })
  assert.match(taskSearchText(replaced), /second revision/)
  clearTaskSearchIndex()
  assert.match(taskSearchText(replaced), /third revision/)
})

test('a quoted match names the message it came from so the palette can land on it', () => {
  const toolTurn = {
    id: 'turn-tool', role: 'assistant' as const, content: 'ran it', startedAt: 2,
    timeline: [{ type: 'tool' as const, tool: { id: 'call-1', name: 'bash', input: 'grep frobnicator src/*', output: 'no match', state: 'done' as const } }],
  }
  const tasks = [task({ id: 'anchored', turns: [userTurn('turn-user', 'the frobnicator shim'), toolTurn] })]
  const [message] = taskSearchMatches(tasks, 'shim', {})
  assert.equal(message.snippet?.turnId, 'turn-user')
  assert.equal(message.snippet?.toolId, undefined)
  const [tool] = taskSearchMatches(tasks, 'grep frobnicator', {})
  assert.equal(tool.snippet?.turnId, 'turn-tool')
  assert.equal(tool.snippet?.toolId, 'call-1')
})

test('the palette shows no project label for a standalone task and no archive affordance', async () => {
  const [app, css] = await Promise.all([
    readFile(new URL('../renderer/src/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../renderer/src/final-refine.css', import.meta.url), 'utf8'),
  ])
  assert.match(app, /\{match\.task\.workspace && <em>\{workspaceLabel\(match\.task\.workspace\)\}<\/em>\}/)
  assert.doesNotMatch(app.slice(app.indexOf('task-search-results'), app.indexOf('task-search-results') + 1200), /item\.archivedAt && <Archive \/>/)
  // A body match has to show what matched, not just the task title.
  assert.match(app, /<mark>\{match\.snippet\.match\}<\/mark>/)
  // Selecting a result jumps to the message that matched, expanding history to reach it.
  assert.match(app, /onClick=\{\(\) => openSearchResult\(match\.task, match\.snippet\)\}/)
  assert.match(app, /hitTurnId=\{showRemote \? undefined : searchHit\?\.taskId === currentId \? searchHit\.turnId : undefined\}/)
  assert.match(app, /if \(target >= 0\) setLimit\(current => Math\.max\(current, turns\.length - target\)\);/)
  assert.match(app, /if \(performance\.now\(\) < deadline\) requestAnimationFrame\(step\);/)
  assert.match(app, /class=\{`\$\{turn\.role\} \$\{turn\.id === running \? "running-turn" : ""\} \$\{turn\.id === hitTurnId \? "search-hit" : ""\}`\}/)
  assert.match(css, /\.feed article\.search-hit\{[^}]*animation:search-hit/)
  assert.match(css, /\.task-search-overlay\{padding:30vh 18px 18px;align-items:flex-start\}/)
  // The field row sits flush with the dialog's top edge, so its own 46px height
  // gives the icon equal room above and below; a top inset here would break that.
  assert.match(css, /\.task-search-dialog\{[^}]*padding:0 10px 10px[^}]*\}/)
  assert.match(css, /\.task-search-snippet mark\{[^}]*color:var\(--text-1\)\}/)
  assert.match(css, /\.task-search-results>button>em\{max-width:140px;justify-self:end/)
})
