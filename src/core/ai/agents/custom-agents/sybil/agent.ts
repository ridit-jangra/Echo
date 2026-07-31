import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import { generateText } from 'ai'
import { ECHO_BASE_DIR } from '../../../utils/env'
import { getModel } from '../../../utils/model'
import { announce, getLastActivityAt } from '../../../../events/announcements'
import { noteProactiveLine } from '../../../index'
import { isDnd } from '../../../../events/dnd'
import { getVisionState } from '../argus/agent'
import { getScreenContext } from '../iris/agent'
import { getBriefing } from '../../../../briefing'
import { currentOpenLoops } from '../../../utils/openLoops'
import type { Briefing } from '../../../../../shared/briefing'

const TICK_MS = 60_000
const HABIT_SAMPLE_MS = 5 * 60_000
const NUDGE_CHECK_MS = 10 * 60_000
const MIN_PATTERN_DAYS = 3
const BRIEFING_HOUR = 9
const CHECKIN_SILENCE_MS = 3 * 60_000
const CHECKIN_COOLDOWN_MS = 45 * 60_000
const CHECKIN_WINDOW_MS = 30 * 60_000
const STATE_FILE = join(ECHO_BASE_DIR, 'sybil-state.json')
const HABITS_FILE = join(ECHO_BASE_DIR, 'habits.jsonl')

const CHECKIN_SYSTEM = `You are Miles, sir's voice companion. Sir hasn't talked to you in a while, and you just glanced at what has been on his screen. Decide his state and whether to speak.

Reply with ONLY raw JSON: {"state":"working"|"stuck"|"idle"|"milestone","line":"..."}

- "working": he's focused and making progress on something. Do NOT interrupt — line must be "".
- "stuck": clear signs of struggle — the same error or problem on screen across many minutes, circling between the same few pages, repeated failed attempts at one thing. line = ONE short warm offer to help that names the specific thing, like a friend glancing over. If told how long he's been at it, you may acknowledge the duration naturally.
- "idle": nothing much happening — desktop, aimless scrolling, paused media. line = ONE casual, natural conversation opener; reference what's on screen only if it genuinely fits.
- "milestone": he just clearly finished or shipped something — a build finally passing after failures, a release published, a PR merged, a long-fought bug closed. line = ONE short, genuine congratulatory remark naming the win. Reserve this for a real, visible win, not routine progress.

line rules: it is spoken aloud by TTS — plain words only, no markdown, under 18 words, address him as "sir", warm-Alfred register, never reveal that you watch or log his screen. Offer only help you can actually deliver: reading the error or page he's on, digging into the code, researching something, pulling something up in the browser, or just talking it through — never vague "assistance". When unsure between working and anything else, pick working and stay silent.`

type State = { lastBriefingDay?: string; nudged?: Record<string, string> }
type HabitSample = { at: number; hour: number; dow: number; present: boolean; app: string | null }
type Pattern = { hour: number; app: string; days: number }

function loadState(): State {
  if (!existsSync(STATE_FILE)) return {}
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as State
  } catch {
    return {}
  }
}

function saveState(state: State): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error('[sybil] failed to save state:', err)
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function shouldStayQuiet(): boolean {
  const vision = getVisionState()
  if (!vision.present) return true
  if (vision.available && vision.attentive === false) return true
  return false
}

export function formatBriefing(b: Briefing): string {
  const parts: string[] = []
  const gh = b.github
  if (gh) {
    if (gh.reviewRequests > 0) {
      parts.push(
        `${gh.reviewRequests} pull request${gh.reviewRequests > 1 ? 's' : ''} waiting on your review`
      )
    }
    if (gh.newStars > 0) {
      parts.push(
        `${gh.newStars} new star${gh.newStars > 1 ? 's' : ''}${gh.starRepo ? ` on ${gh.starRepo.split('/').pop()}` : ''}`
      )
    }
  }
  const slack = b.slack
  if (slack) {
    if (slack.mentions > 0) {
      parts.push(`${slack.mentions} mention${slack.mentions > 1 ? 's' : ''} on Slack`)
    }
    if (slack.unreadDms > 0) {
      parts.push(
        `${slack.unreadDms} unread direct message${slack.unreadDms > 1 ? 's' : ''}${slack.topDmFrom ? `, the busiest from ${slack.topDmFrom}` : ''}`
      )
    }
  }
  if (parts.length === 0)
    return "Morning, sir. Nothing notable came in overnight — you're all clear."
  const list =
    parts.length === 1
      ? parts[0]
      : parts.slice(0, -1).join(', ') + ', and ' + parts[parts.length - 1]
  return `Morning, sir. Overnight you picked up ${list}.`
}

function sampleHabit(): void {
  const now = new Date()
  const ctx = getScreenContext()
  const sample = {
    at: now.getTime(),
    hour: now.getHours(),
    dow: now.getDay(),
    present: getVisionState().present,
    app: ctx.current?.app ?? null
  }
  try {
    appendFileSync(HABITS_FILE, JSON.stringify(sample) + '\n', 'utf-8')
  } catch {
    // best-effort
  }
}

function readHabits(): HabitSample[] {
  if (!existsSync(HABITS_FILE)) return []
  try {
    return readFileSync(HABITS_FILE, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as HabitSample)
  } catch {
    return []
  }
}

// A pattern = the same app seen at the same hour on >= MIN_PATTERN_DAYS distinct days.
export function detectPatterns(samples: HabitSample[]): Pattern[] {
  const byHourApp = new Map<string, Set<string>>()
  for (const s of samples) {
    if (!s.app) continue
    const key = `${s.hour}:${s.app}`
    const day = new Date(s.at).toISOString().slice(0, 10)
    if (!byHourApp.has(key)) byHourApp.set(key, new Set())
    byHourApp.get(key)!.add(day)
  }
  const patterns: Pattern[] = []
  for (const [key, days] of byHourApp) {
    if (days.size < MIN_PATTERN_DAYS) continue
    const [hour, app] = key.split(/:(.+)/)
    patterns.push({ hour: Number(hour), app, days: days.size })
  }
  return patterns.sort((a, b) => b.days - a.days)
}

let stuckSince: number | null = null

async function checkIn(): Promise<void> {
  const cutoff = Date.now() - CHECKIN_WINDOW_MS
  const samples = getScreenContext().recent.filter((s) => s.at >= cutoff)
  if (samples.length < 3) return

  const timeline = samples
    .map((s) => {
      const t = new Date(s.at).toLocaleTimeString()
      const head = `[${t}] ${s.app ?? 'unknown app'} — ${s.title ?? 'no title'}`
      return s.description ? `${head}\n${s.description}` : head
    })
    .join('\n\n')

  const loops = currentOpenLoops()
  const loopsBlock = loops.length
    ? `\n\nSir's open threads from past sessions (context for judging whether he's progressing, circling, or just finished one):\n${loops.map((l) => `- ${l.text}`).join('\n')}`
    : ''

  const stuckBlock = stuckSince
    ? `\n\nNote: he already seemed stuck on this when you last checked — it has been about ${Math.round((Date.now() - stuckSince) / 60000)} minutes total.`
    : ''

  try {
    const { model } = await getModel()
    const res = await generateText({
      model,
      system: CHECKIN_SYSTEM,
      prompt: `What has been on sir's screen recently, oldest first:\n\n${timeline}${loopsBlock}${stuckBlock}`
    })
    const raw = res.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    const verdict = JSON.parse(raw) as { state?: string; line?: string }
    const line = verdict.line?.trim()
    stuckSince = verdict.state === 'stuck' ? (stuckSince ?? Date.now()) : null
    if (
      (verdict.state === 'stuck' || verdict.state === 'idle' || verdict.state === 'milestone') &&
      line
    ) {
      announce(line, true)
      noteProactiveLine(line)
      console.log(`[sybil] check-in (${verdict.state}): ${line}`)
    } else {
      console.log(`[sybil] check-in: staying quiet (${verdict.state ?? 'unparsed'})`)
    }
  } catch (err) {
    console.error('[sybil] check-in failed:', err)
  }
}

export function startSybil(): () => void {
  let stopped = false
  let running = false
  let lastHabitAt = 0
  let lastNudgeCheckAt = 0
  let lastCheckinAt = 0
  const startedAt = Date.now()
  const state = loadState()

  const checkNudge = (): void => {
    if (shouldStayQuiet()) return
    const hour = new Date().getHours()
    const patterns = detectPatterns(readHabits()).filter((p) => p.hour === hour)
    if (patterns.length === 0) return
    const currentApp = getScreenContext().current?.app
    const day = today()
    state.nudged = state.nudged ?? {}
    for (const p of patterns) {
      const key = `${p.hour}:${p.app}`
      if (state.nudged[key] === day) continue
      if (currentApp && currentApp.toLowerCase() === p.app.toLowerCase()) continue
      state.nudged[key] = day
      saveState(state)
      const nudge = `Heads up sir — you usually have ${p.app} going around now.`
      announce(nudge, true)
      noteProactiveLine(nudge)
      console.log(`[sybil] habit nudge for ${p.app} at ${hour}:00`)
      return
    }
  }

  const tick = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      if (Date.now() - lastHabitAt >= HABIT_SAMPLE_MS) {
        lastHabitAt = Date.now()
        sampleHabit()
      }

      if (Date.now() - lastNudgeCheckAt >= NUDGE_CHECK_MS) {
        lastNudgeCheckAt = Date.now()
        checkNudge()
      }

      const silence = Date.now() - Math.max(getLastActivityAt(), startedAt)
      if (
        silence >= CHECKIN_SILENCE_MS &&
        Date.now() - lastCheckinAt >= CHECKIN_COOLDOWN_MS &&
        !shouldStayQuiet() &&
        !isDnd()
      ) {
        lastCheckinAt = Date.now()
        await checkIn()
      }

      const now = new Date()
      if (
        now.getHours() >= BRIEFING_HOUR &&
        state.lastBriefingDay !== today() &&
        !shouldStayQuiet()
      ) {
        state.lastBriefingDay = today()
        saveState(state)
        try {
          const briefing = await getBriefing()
          const line = formatBriefing(briefing)
          announce(line)
          noteProactiveLine(line)
          console.log('[sybil] delivered daily briefing')
        } catch (err) {
          console.error('[sybil] briefing failed:', err)
        }
      }
    } catch (err) {
      console.error('[sybil] tick failed:', err)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), TICK_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
