import { generateText, streamText, stepCountIs } from 'ai'
import { getModel } from './model'
import {
  type Session,
  createSession,
  loadMemoryIntoSession,
  loadPreviousSessionContext,
  saveSession
} from './session'
import type { LLMOptions } from '../types'
import { compactSession, shouldCompact } from './compaction'
import { repairJSON } from './json'

export async function runLLM({
  system,
  tools,
  session,
  prompt,
  mode = 'agent',
  onToolCall,
  onToolResult,
  abortSignal,
  context
}: LLMOptions): Promise<{ text: string; session: Session }> {
  const activeSession = session ?? createSession()
  loadMemoryIntoSession(activeSession)
  const { model } = await getModel()
  await loadPreviousSessionContext(activeSession, model)

  if (shouldCompact(activeSession)) {
    const summary = await generateText({
      model,
      prompt: `summarize this chat: ${JSON.stringify(activeSession.messages)}`
    })
    compactSession(activeSession, summary.text)
  }

  const messagesBeforePrompt = [...activeSession.messages]
  activeSession.messages.push({ role: 'user', content: prompt })

  const toolReminder = tools
    ? `\n\nOnly call these tools: ${Object.keys(tools).join(', ')}.`
    : ''

  const stepLimits: Record<string, number> = {
    chat: 30,
    agent: 150,
    build: 200,
    orchestratorAgent: 50,
    subagent: 50
  }

  const result = await generateText({
    model,
    system: system + toolReminder,
    messages: activeSession.messages,
    stopWhen: stepCountIs(stepLimits[mode] ?? 100),
    tools,
    abortSignal,
    experimental_context: context,
    experimental_repairToolCall: async ({ toolCall }) => {
      const repaired = repairJSON(toolCall.input as string)
      if (repaired === null) return null
      return { ...toolCall, input: JSON.parse(repaired) }
    },
    onStepFinish: ({ toolCalls, toolResults }) => {
      for (const toolCall of toolCalls ?? []) {
        onToolCall?.({
          id: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input
        })
      }
      for (const toolResult of toolResults ?? []) {
        const toolCall = toolCalls?.find((t) => t.toolCallId === toolResult.toolCallId)
        onToolResult?.({
          id: toolResult.toolCallId,
          toolName: toolResult.toolName,
          input: toolCall?.input,
          output: toolResult.output
        })
      }
    }
  })

  activeSession.messages = [
    ...messagesBeforePrompt,
    { role: 'user', content: prompt },
    ...result.response.messages
  ]
  saveSession(activeSession)
  return { text: result.text, session: activeSession }
}

export async function streamLLM({
  system,
  tools,
  session,
  prompt,
  mode = 'chat',
  onToolCall,
  onToolResult,
  onChunk,
  abortSignal,
  context
}: LLMOptions & {
  onChunk: (delta: string) => void
}): Promise<{ text: string; session: Session }> {
  const activeSession = session ?? createSession()
  loadMemoryIntoSession(activeSession)
  const { model } = await getModel()
  await loadPreviousSessionContext(activeSession, model)

  if (shouldCompact(activeSession)) {
    const summary = await generateText({
      model,
      prompt: `summarize this chat: ${JSON.stringify(activeSession.messages)}`
    })
    compactSession(activeSession, summary.text)
  }

  const messagesBeforePrompt = [...activeSession.messages]
  activeSession.messages.push({ role: 'user', content: prompt })

  const toolReminder = tools
    ? `\n\nOnly call these tools: ${Object.keys(tools).join(', ')}.`
    : ''

  const stepLimits: Record<string, number> = {
    chat: 30,
    agent: 150,
    build: 200,
    orchestratorAgent: 50,
    subagent: 50
  }

  const result = streamText({
    model,
    system: system + toolReminder,
    messages: activeSession.messages,
    stopWhen: stepCountIs(stepLimits[mode] ?? 100),
    tools,
    abortSignal,
    experimental_context: context,
    experimental_repairToolCall: async ({ toolCall }) => {
      const repaired = repairJSON(toolCall.input as string)
      if (repaired === null) return null
      return { ...toolCall, input: JSON.parse(repaired) }
    },
    onStepFinish: ({ toolCalls, toolResults }) => {
      for (const toolCall of toolCalls ?? []) {
        onToolCall?.({
          id: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input
        })
      }
      for (const toolResult of toolResults ?? []) {
        const toolCall = toolCalls?.find((t) => t.toolCallId === toolResult.toolCallId)
        onToolResult?.({
          id: toolResult.toolCallId,
          toolName: toolResult.toolName,
          input: toolCall?.input,
          output: toolResult.output
        })
      }
    }
  })

  for await (const delta of result.textStream) {
    onChunk(delta)
  }

  const finalText = await result.text
  const response = await result.response

  activeSession.messages = [
    ...messagesBeforePrompt,
    { role: 'user', content: prompt },
    ...response.messages
  ]
  saveSession(activeSession)

  return { text: finalText, session: activeSession }
}
