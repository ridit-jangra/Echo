type SpeakFn = (text: string, listen: boolean) => void

let emit: SpeakFn | null = null

export function setSpeechEmitter(fn: SpeakFn): void {
  emit = fn
}

// Every narration/notification source (SpeakTool, NotifyTool, subagent checkups and
// results, presence alerts, announcements) funnels through here — so the throttle
// lives in one place instead of being duplicated (and bypassed) per call site.
// Direct questions to sir (listen=true) are exempt: those must never be silently
// dropped by an unrelated cooldown/dedup collision.
const MIN_GAP_MS = 6_000
const RECENT_WINDOW_MS = 10 * 60_000
const RECENT_CAP = 8

let lastSpokenAt = 0
const recent: { text: string; at: number }[] = []

function tokens(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
}

function tooSimilar(a: string, b: string): boolean {
  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return false
  let shared = 0
  for (const w of ta) if (tb.has(w)) shared++
  return shared / Math.max(ta.size, tb.size) >= 0.6
}

/** Ms since anything was last spoken through say(), or Infinity if nothing has been yet. */
export function msSinceLastSpoken(): number {
  return lastSpokenAt ? Date.now() - lastSpokenAt : Infinity
}

/** Returns whether the line was actually spoken (false if throttled/deduped). */
export function say(text: string, listen = false): boolean {
  const trimmed = text?.trim()
  if (!trimmed || !emit) return false

  if (!listen) {
    const now = Date.now()
    while (recent.length && now - recent[0].at > RECENT_WINDOW_MS) recent.shift()

    if (now - lastSpokenAt < MIN_GAP_MS) return false
    if (recent.some((r) => tooSimilar(r.text, trimmed))) return false

    lastSpokenAt = now
    recent.push({ text: trimmed, at: now })
    if (recent.length > RECENT_CAP) recent.shift()
  }

  emit(trimmed, listen)
  return true
}
