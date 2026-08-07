import { generateText } from 'ai'
import { getModel } from '../ai/utils/model'

export type FillerAgent = 'miles' | 'dexter' | 'hank' | 'merlin' | 'scout' | 'otto'

export const FILLER_AGENTS: FillerAgent[] = ['miles', 'dexter', 'hank', 'merlin', 'scout', 'otto']

const PERSONA: Record<FillerAgent, string> = {
  miles:
    'Miles, a warm, direct companion in the style of Alfred or Jarvis, about to think through a reply',
  dexter: 'dexter, a subagent who works Slack and GitHub',
  hank: 'hank, a subagent who writes and edits code and files',
  merlin: 'merlin, a subagent who searches the web and reads sources',
  scout: 'scout, a subagent who drives a browser',
  otto: 'otto, a subagent who runs terminal commands and system controls'
}

const DEFAULTS: Record<FillerAgent, string[]> = {
  miles: ['let me think', 'one sec', "let's see", 'give me a moment', 'hmm, okay'],
  dexter: ['let me check', 'pulling that up', 'digging in', 'one sec', 'looking now'],
  hank: ['let me look', 'checking the code', 'digging in', 'one sec', 'looking now'],
  merlin: ['let me search that', 'looking it up', 'checking online', 'one sec', 'searching now'],
  scout: ['let me pull that up', 'opening it now', 'one sec', 'checking the page', 'looking now'],
  otto: ['on it', 'running that now', 'one sec', 'give me a moment', 'doing that now']
}

const pools: Record<FillerAgent, string[]> = {
  miles: [...DEFAULTS.miles],
  dexter: [...DEFAULTS.dexter],
  hank: [...DEFAULTS.hank],
  merlin: [...DEFAULTS.merlin],
  scout: [...DEFAULTS.scout],
  otto: [...DEFAULTS.otto]
}

const MIN_GAP_MS = 5_000
const refreshing = new Set<FillerAgent>()
const lastRefreshAt: Partial<Record<FillerAgent, number>> = {}

type Emitter = (agent: FillerAgent, pool: string[]) => void
let emit: Emitter | null = null

export function setFillerEmitter(fn: Emitter): void {
  emit = fn
}

export function getFiller(agent: FillerAgent): string {
  const pool = pools[agent]
  return pool[Math.floor(Math.random() * pool.length)]
}

const SYSTEM_PREFIX =
  'You write short spoken filler lines for a voice assistant persona, said the instant before it starts working so sir never sits in dead silence while it thinks, searches, or waits on a slow step. Each line: 2-5 words, casual spoken English, no punctuation besides a comma, no quotes, never "sir". Keep them generic enough to fit whatever comes next rather than naming a specific detail — they play before the real work is known. Return exactly 6 lines, one per line, nothing else.'

/** Fire-and-forget: regenerates an agent's filler pool from recent context. Never blocks the caller. */
export function refreshFillerPool(agent: FillerAgent, context: string): void {
  const now = Date.now()
  if (refreshing.has(agent)) return
  if (now - (lastRefreshAt[agent] ?? 0) < MIN_GAP_MS) return
  lastRefreshAt[agent] = now
  refreshing.add(agent)

  void (async (): Promise<void> => {
    try {
      const { model } = await getModel()
      const res = await generateText({
        model,
        system: `${SYSTEM_PREFIX} Persona: ${PERSONA[agent]}.`,
        prompt:
          context.trim() || 'No specific context yet — general working phrases for this persona.'
      })
      const lines = res.text
        .split('\n')
        .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
        .filter(Boolean)
      if (lines.length) {
        pools[agent] = lines.slice(0, 8)
        emit?.(agent, pools[agent])
      }
    } catch (err) {
      console.error(`[fillers] refresh failed for ${agent}:`, err)
    } finally {
      refreshing.delete(agent)
    }
  })()
}
