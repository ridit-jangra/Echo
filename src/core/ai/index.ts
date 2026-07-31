import { runLLM, streamLLM } from './utils/llm'
import { createSession, Session } from './utils/session'
import { getAgentSystemPrompt } from './utils/systemPrompt'
import { agentTools } from './utils/tools'
import { SpeakTool } from './tools/SpeakTool/tool'
import { KillAgentTool } from './tools/KillAgentTool/tool'
import { ScheduleTool } from './tools/ScheduleTool/tool'
import { MusicTool } from './tools/MusicTool/tool'
import { RecallTool } from './tools/RecallTool/tool'
import { DndTool } from './tools/DndTool/tool'
import { CheckSubagentMemoryTool } from './tools/CheckSubagentMemoryTool/tool'
import { drainSubagentResults } from '../events/subagents'
import { markConversationStart, markConversationEnd } from '../events/announcements'
import { hasPendingQuestion, answerPendingQuestion } from '../events/pending-question'
import { setProactiveNoteHandler } from '../events/proactive-log'

const session = createSession(undefined, 'echo')

const echoTools = {
  ...agentTools,
  SpeakTool,
  KillAgentTool,
  ScheduleTool,
  MusicTool,
  RecallTool,
  DndTool,
  CheckSubagentMemoryTool
}

export const WAKE_SENTINEL = '<<wake>>'

const WAKE_DIRECTIVE = `[System — sir just activated you; the conversation is starting and he hasn't said anything yet. Open it yourself, out loud, with ONE short spoken line in your warm-Alfred register. Vary it every time so you never sound scripted — pick whatever fits this moment: a light motto or wry one-liner, a small remark about the time of day, a random passing thought, or — if the <previous_session> recap above is recent and actually relevant, or an "# Open threads" entry is clearly what he left off — a natural warm callback to it, like "welcome back, sir — you left the relay bridge mid-debug" (in your own words, matched to the actual thread). Just ONE sentence, address him as "sir", no markdown. This is the ONE moment you may open unprompted, but do NOT announce your readiness and do NOT ask what he needs or any productivity-filler question — say your opener and stop.]`

export function noteProactiveLine(line: string): void {
  session.messages.push({
    role: 'user',
    content: `<proactive_line>\nYou just said this to sir on your own initiative (a check-in or nudge, not part of a conversation): "${line}"\nIf he speaks next, it is most likely a reply to that line — respond in that context.\n</proactive_line>`
  })
  session.messages.push({
    role: 'assistant',
    content: "Noted — if sir responds now, I'll treat it as a reply to what I just said."
  })
}

setProactiveNoteHandler(noteProactiveLine)

function flushSubagentResults(): void {
  for (const r of drainSubagentResults()) {
    const status = r.ok ? 'finished' : 'failed'
    session.messages.push({
      role: 'user',
      content: `<subagent_result agent="${r.agent}" status="${status}">\nTask: ${r.task}\nResult:\n${r.result}\n</subagent_result>`
    })
    session.messages.push({
      role: 'assistant',
      content: `Noted — ${r.agent} ${status}, and its result was already spoken to sir aloud. I won't re-announce it; I'll use this if he asks.`
    })
  }
}

export async function chat(prompt: string): Promise<{ text: string; session: Session }> {
  if (hasPendingQuestion()) {
    answerPendingQuestion(prompt)
    return { text: '', session }
  }
  flushSubagentResults()
  markConversationStart()
  try {
    return await runLLM({
      prompt,
      system: await getAgentSystemPrompt(),
      tools: echoTools,
      session,
      onToolCall: (e) => {
        console.log(`[Tool Call]: ${e.toolName}: ${JSON.stringify(e.input)}`)
      },
      onToolResult: (e) => {
        console.log(`[Tool Result]: ${e.toolName}: ${JSON.stringify(e.output)}`)
      }
    })
  } finally {
    markConversationEnd()
  }
}

export async function chatStream(
  prompt: string,
  onChunk: (delta: string) => void
): Promise<{ text: string; session: Session }> {
  if (hasPendingQuestion()) {
    answerPendingQuestion(prompt)
    return { text: '', session }
  }
  flushSubagentResults()
  markConversationStart()
  const effectivePrompt = prompt === WAKE_SENTINEL ? WAKE_DIRECTIVE : prompt
  try {
    return await streamLLM({
      prompt: effectivePrompt,
      system: await getAgentSystemPrompt(),
      tools: echoTools,
      session,
      mode: 'agent',
      onChunk,
      onToolCall: (e) => {
        console.log(`[Tool Call]: ${e.toolName}: ${JSON.stringify(e.input)}`)
      },
      onToolResult: (e) => {
        console.log(`[Tool Result]: ${e.toolName}: ${JSON.stringify(e.output)}`)
      }
    })
  } finally {
    markConversationEnd()
  }
}
