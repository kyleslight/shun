import type { Task, TimelineEntry, Turn } from '../../shared';
import { sortTasksForSidebar, type RunningTasks } from './sidebar-task-order.ts';

/** A single message, note, or tool field never contributes more than this to the index. */
const FIELD_LIMIT = 20_000;
/** Context shown around a body match, in characters. */
const SNIPPET_LIMIT = 120;

/** Where a piece of searchable text came from, so a result can say what matched. */
export type TaskSearchPartKind = 'title' | 'project' | 'you' | 'assistant' | 'tool';
export type TaskSearchPart = { kind: TaskSearchPartKind; text: string; turnId?: string; toolId?: string; name?: string };
export type TaskSearchSnippet = { kind: TaskSearchPartKind; before: string; match: string; after: string; turnId?: string; toolId?: string; name?: string };
export type TaskSearchResult = { task: Task; snippet?: TaskSearchSnippet };

/**
 * Every searchable field of one task, tagged with its origin and the message it
 * belongs to, so a result can both be explained and jumped to. Text stays raw:
 * a case-insensitive pattern test scans it as fast as a lowercase copy does,
 * and skipping the copy keeps a multi-megabyte task cheap to index.
 */
export function taskSearchParts(task: Task): TaskSearchPart[] {
  const parts: TaskSearchPart[] = [];
  const push = (kind: TaskSearchPartKind, text: string | undefined, turn?: Turn, toolId?: string, name?: string) => {
    if (text) parts.push({ kind, text: text.slice(0, FIELD_LIMIT), turnId: turn?.id, toolId, name });
  };
  push('title', task.title);
  push('project', task.workspace);
  for (const turn of task.turns) {
    push(turn.role === 'user' ? 'you' : 'assistant', turn.content, turn);
    const entries: TimelineEntry[] = turn.timeline?.length
      ? turn.timeline
      : (turn.tools || []).map(tool => ({ type: 'tool', tool }));
    for (const entry of entries) {
      if (entry.type === 'text') push('assistant', entry.text, turn);
      else if (entry.type === 'tool') {
        push('tool', entry.tool.input, turn, entry.tool.id, entry.tool.name);
        push('tool', entry.tool.output, turn, entry.tool.id, entry.tool.name);
      }
    }
  }
  return parts;
}

type TaskIndex = { updatedAt: number; text?: string; parts?: TaskSearchPart[] };
const index = new Map<string, TaskIndex>();

function indexFor(task: Task) {
  const cached = index.get(task.id);
  if (cached && cached.updatedAt === task.updatedAt) return cached;
  const fresh: TaskIndex = { updatedAt: task.updatedAt };
  index.set(task.id, fresh);
  return fresh;
}

/**
 * On-device full-text index. A task is joined once per palette session and
 * reused for every following keystroke, so a query costs one substring scan
 * over the open tasks instead of re-walking every turn. Only the palette's open
 * rows ever ask for the tagged parts they need to quote.
 */
export function taskSearchText(task: Task) {
  const entry = indexFor(task);
  return entry.text ??= taskSearchPartsOf(entry, task).map(part => part.text).join('\n');
}

/** The excerpt around the first match, preferring a message over a tool dump. */
export function taskSearchSnippet(task: Task, pattern: RegExp): TaskSearchSnippet | undefined {
  const parts = taskSearchPartsOf(indexFor(task), task);
  let source: TaskSearchPart | undefined, located: RegExpExecArray | null = null;
  for (const part of parts) {
    if (part.kind !== 'you' && part.kind !== 'assistant') continue;
    located = pattern.exec(part.text);
    if (located) { source = part; break; }
  }
  if (!source) for (const part of parts) {
    located = pattern.exec(part.text);
    if (located) { source = part; break; }
  }
  if (!source || !located) return undefined;
  const start = located.index, end = start + located[0].length;
  const from = Math.max(0, start - Math.floor(Math.max(0, SNIPPET_LIMIT - (end - start)) / 2));
  const to = Math.min(source.text.length, from + SNIPPET_LIMIT);
  const flatten = (value: string) => value.replace(/\s+/g, ' ');
  return {
    kind: source.kind,
    turnId: source.turnId,
    toolId: source.toolId,
    name: source.name,
    before: (from > 0 ? '…' : '') + flatten(source.text.slice(from, start)),
    match: flatten(located[0]),
    after: flatten(source.text.slice(end, to)) + (to < source.text.length ? '…' : ''),
  };
}

function taskSearchPartsOf(entry: TaskIndex, task: Task) {
  return entry.parts ??= taskSearchParts(task);
}

/** How many tasks the open palette is currently holding; 0 once the palette closes. */
export function taskSearchIndexSize() {
  return index.size;
}

/** Called when the palette closes so search text is never retained for the session. */
export function clearTaskSearchIndex() {
  index.clear();
}

function patternFor(needle: string) {
  return new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/**
 * Search results rank a title or project match above a body match, then keep
 * the sidebar's recency order inside each group. Archived tasks are never
 * results, so the palette needs no archive affordance of its own. Only rows the
 * palette will actually show pay for an excerpt.
 */
export function taskSearchMatches(tasks: Task[], query: string, runningTasks: RunningTasks, limit = 9): TaskSearchResult[] {
  const candidates = sortTasksForSidebar(
    // The palette lists started tasks only, and never an archived one.
    tasks.filter(task => task.turns.length > 0 && !task.archivedAt),
    runningTasks,
  );
  const needle = query.trim();
  if (!needle) return candidates.slice(0, limit).map(task => ({ task }));
  const pattern = patternFor(needle);
  const titles: TaskSearchResult[] = [], bodies: Task[] = [];
  for (const task of candidates) {
    if (pattern.test(`${task.title} ${task.workspace}`)) titles.push({ task });
    else if (pattern.test(taskSearchText(task))) bodies.push(task);
  }
  const room = limit - titles.length;
  return [...titles, ...bodies.slice(0, Math.max(0, room)).map(task => ({ task, snippet: taskSearchSnippet(task, pattern) }))].slice(0, limit);
}
