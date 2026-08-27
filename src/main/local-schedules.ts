import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Cron } from 'croner'
import type { LocalSchedule, LocalScheduleEvent, LocalScheduleInput, LocalSchedulePatch, LocalScheduleTrigger } from '../shared.ts'

export type LocalScheduleOccurrence = { id: string; scheduleId: string; dueAt: number; queuedAt: number; state: 'queued' | 'running' }

type StoredState = { version: 1; schedules: LocalSchedule[]; pending: LocalScheduleOccurrence[] }
type ScheduleHandler = (schedule: LocalSchedule, occurrence: LocalScheduleOccurrence) => Promise<void> | void

const MAX_TIMER_MS = 2_147_000_000

export class LocalScheduleManager {
  readonly #storageFile: string
  readonly #onOccurrence: ScheduleHandler
  readonly #emit: (event: LocalScheduleEvent) => void
  readonly #now: () => number
  readonly #schedules = new Map<string, LocalSchedule>()
  readonly #pending = new Map<string, LocalScheduleOccurrence>()
  readonly #delivering = new Set<string>()
  #timer?: NodeJS.Timeout
  #write = Promise.resolve()
  #ready = false

  constructor(storageFile: string, onOccurrence: ScheduleHandler, emit: (event: LocalScheduleEvent) => void = () => {}, now = Date.now) {
    this.#storageFile = storageFile
    this.#onOccurrence = onOccurrence
    this.#emit = emit
    this.#now = now
  }

  async init() {
    if (this.#ready) return
    const stored = await this.#read()
    for (const value of stored.schedules) {
      try {
        const schedule = normalizeStoredSchedule(value)
        this.#schedules.set(schedule.id, schedule)
      } catch {}
    }
    for (const value of stored.pending) {
      if (!value || typeof value.id !== 'string' || typeof value.scheduleId !== 'string' || !Number.isFinite(value.dueAt) || !Number.isFinite(value.queuedAt)) continue
      const schedule = this.#schedules.get(value.scheduleId)
      if (!schedule) continue
      if (value.state === 'running') {
        schedule.lastStatus = 'failed'
        schedule.lastError = 'The previous scheduled run was interrupted when Shun stopped.'
        schedule.updatedAt = this.#now()
        continue
      }
      this.#pending.set(value.id, { ...value, state: 'queued' })
    }
    this.#ready = true
    await this.#persist()
    await this.#recoverMissed()
    this.#arm()
    for (const occurrence of this.#pending.values()) this.#deliver(occurrence)
  }

  list(taskId?: string) {
    const selected = taskId ? [...this.#schedules.values()].filter(schedule => schedule.taskId === taskId) : [...this.#schedules.values()]
    return selected.sort((a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt).map(cloneSchedule)
  }

  get(idValue: string) {
    const schedule = this.#schedules.get(validId(idValue, 'schedule'))
    return schedule ? cloneSchedule(schedule) : undefined
  }

  async create(input: LocalScheduleInput) {
    this.#requireReady()
    const now = this.#now()
    const trigger = normalizeTrigger(input.trigger)
    const schedule: LocalSchedule = {
      id: randomUUID(),
      taskId: validId(input.taskId, 'task'),
      name: requiredText(input.name, 'Schedule name', 120),
      prompt: requiredText(input.prompt, 'Schedule prompt', 20_000),
      trigger,
      status: 'active',
      missedPolicy: input.missedPolicy === 'skip' ? 'skip' : 'run_once',
      nextRunAt: nextRun(trigger, now - 1),
      createdAt: now,
      updatedAt: now,
    }
    this.#schedules.set(schedule.id, schedule)
    await this.#persist()
    this.#changed(schedule)
    this.#arm()
    void this.#tick()
    return cloneSchedule(schedule)
  }

  async update(idValue: string, patch: LocalSchedulePatch) {
    this.#requireReady()
    const id = validId(idValue, 'schedule'), current = this.#schedules.get(id)
    if (!current) throw Error('Scheduled task not found.')
    const now = this.#now(), trigger = patch.trigger ? normalizeTrigger(patch.trigger) : current.trigger
    const status = patch.status === 'active' || patch.status === 'paused' || patch.status === 'completed' ? patch.status : current.status
    const schedule: LocalSchedule = {
      ...current,
      ...(patch.name !== undefined ? { name: requiredText(patch.name, 'Schedule name', 120) } : {}),
      ...(patch.prompt !== undefined ? { prompt: requiredText(patch.prompt, 'Schedule prompt', 20_000) } : {}),
      trigger,
      status,
      missedPolicy: patch.missedPolicy === 'skip' || patch.missedPolicy === 'run_once' ? patch.missedPolicy : current.missedPolicy,
      nextRunAt: status === 'active'
        ? (patch.trigger || current.status !== 'active' ? nextRun(trigger, now - 1) : (current.nextRunAt ?? nextRun(trigger, now - 1)))
        : undefined,
      updatedAt: now,
    }
    if (status !== 'active') {
      for (const occurrence of this.#pending.values()) if (occurrence.scheduleId === id && !this.#delivering.has(occurrence.id)) this.#pending.delete(occurrence.id)
    }
    this.#schedules.set(id, schedule)
    await this.#persist()
    this.#changed(schedule)
    this.#arm()
    return cloneSchedule(schedule)
  }

  async remove(idValue: string) {
    this.#requireReady()
    const id = validId(idValue, 'schedule'), schedule = this.#schedules.get(id)
    if (!schedule) return false
    this.#schedules.delete(id)
    for (const occurrence of this.#pending.values()) if (occurrence.scheduleId === id && !this.#delivering.has(occurrence.id)) this.#pending.delete(occurrence.id)
    await this.#persist()
    this.#emit({ type: 'changed', removedId: id, taskId: schedule.taskId })
    this.#arm()
    return true
  }

  async removeForTask(taskIdValue: string) {
    this.#requireReady()
    const taskId = validId(taskIdValue, 'task'), ids = [...this.#schedules.values()].filter(item => item.taskId === taskId).map(item => item.id)
    if (!ids.length) return 0
    for (const id of ids) this.#schedules.delete(id)
    for (const occurrence of this.#pending.values()) if (ids.includes(occurrence.scheduleId) && !this.#delivering.has(occurrence.id)) this.#pending.delete(occurrence.id)
    await this.#persist()
    for (const id of ids) this.#emit({ type: 'changed', removedId: id, taskId })
    this.#arm()
    return ids.length
  }

  async runNow(idValue: string) {
    this.#requireReady()
    const id = validId(idValue, 'schedule'), schedule = this.#schedules.get(id)
    if (!schedule) throw Error('Scheduled task not found.')
    const occurrence = this.#queueOccurrence(schedule, this.#now())
    await this.#persist()
    this.#changed(schedule)
    this.#deliver(occurrence)
    return cloneSchedule(schedule)
  }

  async markRunning(occurrenceId: string) {
    const occurrence = this.#pending.get(occurrenceId), schedule = occurrence && this.#schedules.get(occurrence.scheduleId)
    if (!occurrence || !schedule) return
    occurrence.state = 'running'
    schedule.lastRunAt = this.#now()
    schedule.lastStatus = 'running'
    schedule.lastError = undefined
    schedule.updatedAt = this.#now()
    await this.#persist()
    this.#changed(schedule)
  }

  async finishOccurrence(occurrenceId: string, error?: unknown) {
    const occurrence = this.#pending.get(occurrenceId), schedule = occurrence && this.#schedules.get(occurrence.scheduleId)
    this.#pending.delete(occurrenceId)
    this.#delivering.delete(occurrenceId)
    if (schedule) {
      schedule.lastStatus = error ? 'failed' : 'succeeded'
      schedule.lastError = error ? errorText(error) : undefined
      schedule.updatedAt = this.#now()
    }
    await this.#persist()
    if (schedule) this.#changed(schedule)
  }

  refresh() {
    if (!this.#ready) return
    void this.#tick()
  }

  dispose() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  async #recoverMissed() {
    const now = this.#now()
    let changed = false
    for (const schedule of this.#schedules.values()) {
      if (schedule.status !== 'active') continue
      const dueAt = schedule.nextRunAt ?? nextRun(schedule.trigger, schedule.updatedAt)
      if (dueAt > now) { schedule.nextRunAt = dueAt; continue }
      if (schedule.missedPolicy === 'run_once' && !this.#hasPending(schedule.id)) this.#queueOccurrence(schedule, dueAt)
      else if (schedule.missedPolicy === 'skip') {
        schedule.lastStatus = 'skipped'
        schedule.updatedAt = now
      }
      this.#advance(schedule, now)
      changed = true
    }
    if (changed) await this.#persist()
  }

  async #tick() {
    if (!this.#ready) return
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    const now = this.#now(), queued: LocalScheduleOccurrence[] = []
    let changed = false
    for (const schedule of this.#schedules.values()) {
      if (schedule.status !== 'active' || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      const dueAt = schedule.nextRunAt
      if (!this.#hasPending(schedule.id)) queued.push(this.#queueOccurrence(schedule, dueAt))
      this.#advance(schedule, now)
      changed = true
    }
    if (changed) await this.#persist()
    this.#arm()
    for (const occurrence of queued) this.#deliver(occurrence)
  }

  #advance(schedule: LocalSchedule, now: number) {
    if (schedule.trigger.kind === 'once') {
      schedule.status = 'completed'
      schedule.nextRunAt = undefined
    } else schedule.nextRunAt = nextRun(schedule.trigger, now)
    schedule.updatedAt = now
  }

  #queueOccurrence(schedule: LocalSchedule, dueAt: number) {
    const id = `${schedule.id}:${Math.floor(dueAt)}`
    const existing = this.#pending.get(id)
    if (existing) return existing
    const occurrence: LocalScheduleOccurrence = { id, scheduleId: schedule.id, dueAt, queuedAt: this.#now(), state: 'queued' }
    this.#pending.set(id, occurrence)
    schedule.lastStatus = 'queued'
    schedule.lastError = undefined
    schedule.updatedAt = this.#now()
    return occurrence
  }

  #hasPending(scheduleId: string) {
    return [...this.#pending.values()].some(item => item.scheduleId === scheduleId)
  }

  #deliver(occurrence: LocalScheduleOccurrence) {
    if (this.#delivering.has(occurrence.id)) return
    const schedule = this.#schedules.get(occurrence.scheduleId)
    if (!schedule) return
    this.#delivering.add(occurrence.id)
    Promise.resolve(this.#onOccurrence(cloneSchedule(schedule), { ...occurrence })).catch(error => this.finishOccurrence(occurrence.id, error))
  }

  #arm() {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    const next = Math.min(...[...this.#schedules.values()].filter(item => item.status === 'active' && item.nextRunAt !== undefined).map(item => item.nextRunAt!))
    if (!Number.isFinite(next)) return
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, next - this.#now()))
    this.#timer = setTimeout(() => void this.#tick(), delay)
    this.#timer.unref()
  }

  #changed(schedule: LocalSchedule) {
    this.#emit({ type: 'changed', schedule: cloneSchedule(schedule), taskId: schedule.taskId })
  }

  #persist() {
    const state: StoredState = { version: 1, schedules: [...this.#schedules.values()].map(cloneSchedule), pending: [...this.#pending.values()].map(item => ({ ...item })) }
    const write = this.#write.catch(() => {}).then(async () => {
      await mkdir(dirname(this.#storageFile), { recursive: true })
      const temp = `${this.#storageFile}.tmp`
      await writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temp, this.#storageFile)
    })
    this.#write = write
    return write
  }

  async #read(): Promise<StoredState> {
    try {
      const parsed = JSON.parse(await readFile(this.#storageFile, 'utf8'))
      return { version: 1, schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [], pending: Array.isArray(parsed.pending) ? parsed.pending : [] }
    } catch { return { version: 1, schedules: [], pending: [] } }
  }

  #requireReady() {
    if (!this.#ready) throw Error('Scheduled tasks are still loading.')
  }
}

function normalizeStoredSchedule(value: LocalSchedule): LocalSchedule {
  if (!value || typeof value !== 'object') throw Error('Invalid scheduled task.')
  const trigger = normalizeTrigger(value.trigger), status = value.status === 'paused' || value.status === 'completed' ? value.status : 'active'
  return {
    id: validId(value.id, 'schedule'), taskId: validId(value.taskId, 'task'), name: requiredText(value.name, 'Schedule name', 120), prompt: requiredText(value.prompt, 'Schedule prompt', 20_000), trigger, status,
    missedPolicy: value.missedPolicy === 'skip' ? 'skip' : 'run_once',
    ...(Number.isFinite(value.nextRunAt) && status === 'active' ? { nextRunAt: Number(value.nextRunAt) } : {}),
    ...(Number.isFinite(value.lastRunAt) ? { lastRunAt: Number(value.lastRunAt) } : {}),
    ...(['queued', 'running', 'succeeded', 'failed', 'skipped'].includes(String(value.lastStatus)) ? { lastStatus: value.lastStatus } : {}),
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError.slice(0, 1_000) } : {}),
    createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : Date.now(), updatedAt: Number.isFinite(value.updatedAt) ? Number(value.updatedAt) : Date.now(),
  }
}

function normalizeTrigger(value: LocalScheduleTrigger): LocalScheduleTrigger {
  if (value?.kind === 'once') {
    const at = requiredText(value.at, 'Run time', 100), timestamp = Date.parse(at)
    if (!Number.isFinite(timestamp)) throw Error('Run time must be a valid ISO date and time.')
    return { kind: 'once', at: new Date(timestamp).toISOString() }
  }
  if (value?.kind === 'cron') {
    const expression = requiredText(value.expression, 'Cron expression', 200), timezone = requiredText(value.timezone, 'Timezone', 100)
    if (expression.split(/\s+/).length !== 5) throw Error('Cron expression must contain exactly five fields: minute hour day month weekday.')
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date()) } catch { throw Error('Timezone must be a valid IANA timezone such as Asia/Shanghai.') }
    new Cron(expression, { timezone, paused: true, mode: '5-part' })
    return { kind: 'cron', expression, timezone }
  }
  throw Error('Schedule trigger must be once or cron.')
}

function nextRun(trigger: LocalScheduleTrigger, after: number) {
  if (trigger.kind === 'once') return Date.parse(trigger.at)
  const date = new Cron(trigger.expression, { timezone: trigger.timezone, paused: true, mode: '5-part' }).nextRun(new Date(after))
  if (!date) throw Error('Cron expression has no future run time.')
  return date.getTime()
}

function validId(value: unknown, name: string) {
  const id = String(value || '')
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw Error(`Invalid ${name} ID.`)
  return id
}

function requiredText(value: unknown, name: string, max: number) {
  const text = String(value || '').trim()
  if (!text) throw Error(`${name} is required.`)
  if (text.length > max) throw Error(`${name} is too long.`)
  return text
}

function cloneSchedule(schedule: LocalSchedule): LocalSchedule {
  return { ...schedule, trigger: { ...schedule.trigger } }
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000)
}
