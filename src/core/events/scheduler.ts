import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { ECHO_BASE_DIR } from '../ai/utils/env'
import { announce } from './announcements'
import { narrateSubagentResult, narrateStaleReminder } from './narrate'
import { noteProactiveSpoken } from './proactive-log'
import {
  startSubagentRun,
  appendSubagentActivity,
  completeSubagentRun,
  recordSubagentResult,
  getSubagentRun,
  getSubagentSignal
} from './subagents'
import { chatStream as dexter } from '../ai/agents/custom-agents/dexter/agent'
import { chatStream as hank } from '../ai/agents/custom-agents/hank/agent'
import { chatStream as merlin } from '../ai/agents/custom-agents/merlin/agent'
import { chatStream as scout } from '../ai/agents/custom-agents/scout/agent'
import { chatStream as otto } from '../ai/agents/custom-agents/otto/agent'

const SCHEDULES_FILE = join(ECHO_BASE_DIR, 'schedules.json')
const TICK_MS = 20_000
const STALE_THRESHOLD_MS = 3 * 60_000

function stalePhrase(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'}`
  const d = Math.round(hr / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

const AGENTS = { dexter, hank, merlin, scout, otto } as const

export type ScheduleAgent = keyof typeof AGENTS

export type ScheduleEntry = {
  id: string
  label: string
  kind: 'once' | 'daily' | 'interval'
  nextAt: number
  time?: string
  everyMs?: number
  speak?: string
  task?: { agent: ScheduleAgent; instruction: string }
  createdAt: number
  lastFiredAt?: number
}

function loadSchedules(): ScheduleEntry[] {
  if (!existsSync(SCHEDULES_FILE)) return []
  try {
    const parsed = JSON.parse(readFileSync(SCHEDULES_FILE, 'utf-8'))
    return Array.isArray(parsed) ? (parsed as ScheduleEntry[]) : []
  } catch {
    return []
  }
}

function saveSchedules(entries: ScheduleEntry[]): void {
  try {
    writeFileSync(SCHEDULES_FILE, JSON.stringify(entries, null, 2), 'utf-8')
  } catch (err) {
    console.error('[scheduler] failed to save schedules:', err)
  }
}

export function nextDailyAt(time: string, after: number): number {
  const [h, m] = time.split(':').map(Number)
  const d = new Date(after)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= after) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export function createSchedule(entry: Omit<ScheduleEntry, 'id' | 'createdAt'>): ScheduleEntry {
  const full: ScheduleEntry = {
    ...entry,
    id: crypto.randomUUID().slice(0, 8),
    createdAt: Date.now()
  }
  const entries = loadSchedules()
  entries.push(full)
  saveSchedules(entries)
  return full
}

export function listSchedules(): ScheduleEntry[] {
  return loadSchedules().sort((a, b) => a.nextAt - b.nextAt)
}

export function cancelSchedule(id: string): ScheduleEntry | undefined {
  const entries = loadSchedules()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return undefined
  const [removed] = entries.splice(idx, 1)
  saveSchedules(entries)
  return removed
}

function runTask(entry: ScheduleEntry): void {
  const { agent, instruction } = entry.task!
  const runId = startSubagentRun(agent, instruction)
  void AGENTS[agent](
    instruction,
    (delta) => appendSubagentActivity(runId, delta),
    getSubagentSignal(runId)
  )
    .then(async ({ text }) => {
      if (getSubagentRun(runId)?.status === 'killed') return
      completeSubagentRun(runId, true)
      recordSubagentResult({
        agent,
        task: `[scheduled: ${entry.label}] ${instruction}`,
        result: text,
        ok: true
      })
      announce(await narrateSubagentResult(agent, instruction, text))
    })
    .catch((err) => {
      if (getSubagentRun(runId)?.status === 'killed') return
      completeSubagentRun(runId, false)
      const message = err instanceof Error ? err.message : String(err)
      recordSubagentResult({
        agent,
        task: `[scheduled: ${entry.label}] ${instruction}`,
        result: `Failed: ${message}`,
        ok: false
      })
      announce(`Sir, the scheduled ${entry.label} task hit a problem.`)
      console.error(`[scheduler] task "${entry.label}" failed:`, err)
    })
}

function speakReminder(text: string): void {
  announce(text)
  noteProactiveSpoken(text)
}

function fire(entry: ScheduleEntry): void {
  if (entry.speak) {
    const staleMs = Date.now() - entry.nextAt
    if (staleMs > STALE_THRESHOLD_MS) {
      const original = entry.speak
      void narrateStaleReminder(original, stalePhrase(staleMs)).then(speakReminder)
    } else {
      speakReminder(entry.speak)
    }
  }
  if (entry.task) runTask(entry)
}

export function startScheduler(): () => void {
  let stopped = false

  const tick = (): void => {
    if (stopped) return
    const now = Date.now()
    const entries = loadSchedules()
    let changed = false

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.nextAt > now) continue

      try {
        fire(entry)
      } catch (err) {
        console.error(`[scheduler] failed to fire "${entry.label}":`, err)
      }

      entry.lastFiredAt = now
      if (entry.kind === 'once') entries.splice(i, 1)
      else if (entry.kind === 'daily' && entry.time) entry.nextAt = nextDailyAt(entry.time, now)
      else if (entry.kind === 'interval' && entry.everyMs) entry.nextAt = now + entry.everyMs
      else entries.splice(i, 1)
      changed = true
    }

    if (changed) saveSchedules(entries)
  }

  const timer = setInterval(tick, TICK_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
