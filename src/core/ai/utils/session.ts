/* eslint-disable @typescript-eslint/no-require-imports */
import { generateText, type ModelMessage, type LanguageModel } from 'ai'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { PROJECT_MEMORY_FILE, SESSIONS_DIR, MEMORY_DIR } from './env'
import { harvestOpenLoops } from './openLoops'

export type Session = {
  id: string
  kind?: string
  messages: ModelMessage[]
  memoryLoaded: boolean
  continuityLoaded?: boolean
  summary?: string
  loopsHarvested?: boolean
  createdAt: number
  updatedAt: number
  compacted?: boolean
}

export function createSession(id?: string, kind?: string): Session {
  return {
    id: id ?? crypto.randomUUID(),
    kind,
    messages: [],
    memoryLoaded: false,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

export function saveSession(session: Session): void {
  mkdirSync(SESSIONS_DIR, { recursive: true })
  const path = join(SESSIONS_DIR, `${session.id}.json`)
  session.updatedAt = Date.now()
  writeFileSync(path, JSON.stringify(session, null, 2), 'utf-8')
}

export function loadSession(id: string): Session | null {
  const path = join(SESSIONS_DIR, `${id}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Session
  } catch {
    return null
  }
}

export function listSessions(): {
  id: string
  createdAt: number
  updatedAt: number
}[] {
  if (!existsSync(SESSIONS_DIR)) return []
  const { readdirSync } = require('fs')
  return readdirSync(SESSIONS_DIR)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => {
      try {
        const session = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8')) as Session
        return {
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt
        }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadMemoryIntoSession(session: Session): Session {
  if (session.memoryLoaded) return session

  const parts: string[] = []

  const projectMem = existsSync(PROJECT_MEMORY_FILE)
    ? readFileSync(PROJECT_MEMORY_FILE, 'utf-8').trim()
    : ''
  if (projectMem) parts.push(`# Project Memory\n${projectMem}`)

  if (existsSync(MEMORY_DIR)) {
    const files = readdirSync(MEMORY_DIR)
      .filter((f) => f.endsWith('.md') || f.endsWith('.mdc'))
      .sort()
    for (const file of files) {
      try {
        const content = readFileSync(join(MEMORY_DIR, file), 'utf-8').trim()
        if (content) parts.push(`## ${file}\n${content}`)
      } catch {
        // skip unreadable memory file
      }
    }
  }

  const memoryContext = parts.join('\n\n')

  if (memoryContext) {
    session.messages.push({
      role: 'user',
      content: `<memory>\n${memoryContext}\n</memory>`
    })
    session.messages.push({
      role: 'assistant',
      content: "Memory loaded. I'll apply these throughout our session."
    })
  }

  session.memoryLoaded = true
  return session
}

function loadAllSessions(): Session[] {
  if (!existsSync(SESSIONS_DIR)) return []
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf-8')) as Session
      } catch {
        return null
      }
    })
    .filter((s): s is Session => !!s)
}

function persistSummary(session: Session): void {
  try {
    const path = join(SESSIONS_DIR, `${session.id}.json`)
    writeFileSync(path, JSON.stringify(session, null, 2), 'utf-8')
  } catch {
    // best-effort cache
  }
}

function elapsedPhrase(from: number, to: number): string {
  const min = Math.round(Math.max(0, to - from) / 60000)
  if (min < 1) return 'less than a minute'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'}`
  const d = Math.round(hr / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

async function summarizeSession(session: Session, model: LanguageModel): Promise<string> {
  const convo = session.messages.filter((m) => {
    const c = typeof m.content === 'string' ? m.content : ''
    return !(
      c.startsWith('<memory>') ||
      c.startsWith('<previous_session>') ||
      c.startsWith('Memory loaded') ||
      c.startsWith('Got it, continuing')
    )
  })
  if (convo.length === 0) return ''
  const { text } = await generateText({
    model,
    system:
      "Write a thorough recap of this voice conversation between Echo (the assistant) and sir, as if briefing yourself before picking it back up. Capture everything worth remembering: every topic discussed, specific facts, names, numbers, files, and decisions mentioned, what was done or built, sir's stated preferences or corrections, and anything left open or unfinished. Be comprehensive and specific rather than vague — use as many sentences as it takes to actually cover what happened; do not compress this down to a couple of lines. Plain prose, no markdown, no headers.",
    prompt: JSON.stringify(convo)
  })
  return text.trim()
}

export async function loadPreviousSessionContext(
  session: Session,
  model: LanguageModel
): Promise<Session> {
  if (session.continuityLoaded) return session
  session.continuityLoaded = true
  if (session.kind !== 'echo') return session

  const prior = loadAllSessions()
    .filter((s) => s.id !== session.id && s.kind === 'echo')
    .filter((s) => s.messages.some((m) => m.role === 'assistant'))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!prior) return session

  const lastSeen = prior.updatedAt
  let summary = prior.summary
  if (!summary) {
    try {
      summary = await summarizeSession(prior, model)
      if (summary) {
        prior.summary = summary
        persistSummary(prior)
      }
    } catch {
      summary = ''
    }
  }

  if (!prior.loopsHarvested) {
    prior.loopsHarvested = true
    persistSummary(prior)
    try {
      await harvestOpenLoops(model, prior.messages)
    } catch (err) {
      console.error('[session] open-loop harvest failed:', err)
    }
  }

  if (!summary) return session

  session.messages.push({
    role: 'user',
    content: `<previous_session>\nIt is now ${new Date().toLocaleString()}. You last spoke with sir about ${elapsedPhrase(lastSeen, Date.now())} ago.\nRecap of that conversation:\n${summary}\n</previous_session>`
  })
  session.messages.push({
    role: 'assistant',
    content:
      "Noted — that's just background. I'll wait for sir and respond to what he says, without prompting him to resume it."
  })

  return session
}
