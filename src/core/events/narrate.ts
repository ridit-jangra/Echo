import { generateText } from 'ai'
import { getModel } from '../ai/utils/model'
import type { EventAlert } from '../../shared/events'

const SYSTEM =
  "You are Echo, sir's voice assistant. Give a single short, natural spoken heads-up about a Slack notification — one casual sentence, like a friend nudging him. Do NOT read the message verbatim or use quotes; just let him know something came in and (only if it fits) hint you can help. Keep it under 20 words."

const SUBAGENT_SYSTEM =
  "You are Echo, sir's voice assistant. A background helper you delegated to just finished. Confirm the outcome to sir in ONE short, natural spoken sentence — plain English, no markdown, lists, code, urls, or file paths. State only the result, never the process or internal steps: never mention saving to memory, navigating, tools, or where data was stored — sir doesn't care how, only what came of it. If the helper's text only describes process (e.g. 'saved it to memory', 'navigated to the page') without a real answer, just confirm it's done plainly (e.g. 'Got those for you, sir.'). For a simple action confirm it in a few words (e.g. 'Done, music's stopped.'). Don't pad it."

const SUBAGENT_CHECKUP_SYSTEM =
  "You are Echo, sir's voice assistant. A background helper you delegated to is STILL working, and you're proactively checking in. Give sir ONE short, casual spoken nudge about how it's going, grounded in what the helper is currently doing — plain English, no markdown, lists, code, urls, or file paths. Don't restate the whole task or claim it's done; it's just a 'still on it' style heads-up. Under 18 words."

const STALE_REMINDER_SYSTEM =
  "You are Echo, sir's voice assistant. A reminder you set for him is firing well after it was supposed to — his machine was probably off, asleep, or the app was closed at the scheduled time, so you're only saying this long after the fact. Rephrase it in ONE short, natural spoken sentence that fits the delay: if the original referenced a specific time or event that has clearly already passed, don't restate it as upcoming — acknowledge you're late and ask whether he already did it or attended it. If it's something still worth doing now, just note it's overdue. Plain English, no markdown, lists, code, urls, or file paths."

export async function narrateSubagentCheckup(
  agent: string,
  task: string,
  activity: string
): Promise<string> {
  try {
    const { model } = await getModel()
    const res = await generateText({
      model,
      system: SUBAGENT_CHECKUP_SYSTEM,
      prompt: `${agent} is still working on: ${task}\n\nWhat it's currently doing:\n${activity || '(no output yet)'}\n\nGive sir a quick progress nudge.`
    })
    return res.text.trim() || `${agent} is still working on that, sir.`
  } catch {
    return `${agent} is still working on that, sir.`
  }
}

export async function narrateSubagentResult(
  agent: string,
  task: string,
  result: string
): Promise<string> {
  try {
    const { model } = await getModel()
    const res = await generateText({
      model,
      system: SUBAGENT_SYSTEM,
      prompt: `${agent} was asked to: ${task}\n\nIts result:\n${result}\n\nTell sir what came of it.`
    })
    return res.text.trim() || `${agent} finished that for you, sir.`
  } catch {
    return `${agent} finished that for you, sir.`
  }
}

export async function narrateStaleReminder(
  originalText: string,
  staleFor: string
): Promise<string> {
  try {
    const { model } = await getModel()
    const res = await generateText({
      model,
      system: STALE_REMINDER_SYSTEM,
      prompt: `Original reminder: "${originalText}"\n\nThis is firing about ${staleFor} later than it was scheduled for. Give sir the late version of this reminder.`
    })
    return res.text.trim() || originalText
  } catch {
    return originalText
  }
}

export async function narrateAlert(alert: EventAlert): Promise<string> {
  const where = alert.channelName ?? 'a channel'
  const detail =
    alert.count && alert.count > 1
      ? `${alert.count} new messages in ${where}. The latest is: ${alert.text ?? ''}`
      : `a new message in ${where}: ${alert.text ?? ''}`
  try {
    const { model } = await getModel()
    const res = await generateText({
      model,
      system: SYSTEM,
      prompt: `Give sir a heads-up about ${detail}`
    })
    return res.text.trim() || alert.summary
  } catch {
    return alert.summary
  }
}
