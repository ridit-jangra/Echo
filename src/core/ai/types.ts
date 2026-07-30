import type { ToolSet } from 'ai'
import type { Session } from './utils/session'
import type React from 'react'

export type Mode = 'chat' | 'agent' | 'build'

export type ChatMessage =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant'; text: string }
  | {
      id: string
      type: 'tool_call'
      toolName: string
      input: unknown
      isOrchestrated?: boolean
      taskId?: string
    }
  | {
      id: string
      type: 'tool_result'
      toolName: string
      input: unknown
      output: unknown
      success: boolean
      isOrchestrated?: boolean
      taskId?: string
    }
  | {
      id: string
      type: 'permission_request'
      toolName: string
      input: unknown
      preview: unknown
      resolve: (decision: PermissionDecision) => void
    }

export interface Theme {
  name: string
  primary: string
  secondary: string
  border: string
  secondaryBorder: string
  text: string
  secondaryText: string
  suggestion: string
  success: string
  error: string
  money: string
  warning: string
  diff: {
    added: string
    removed: string
    addedDimmed: string
    removedDimmed: string
  }
}

export type StepToolCall = {
  id: string
  toolName: string
  input: unknown
}

export type StepToolResult = {
  id: string
  toolName: string
  output: unknown
  input?: unknown
}

export type LLMOptions = {
  system: string
  tools?: ToolSet
  session?: Session
  prompt: string
  mode?: 'chat' | 'agent' | 'build' | 'subagent' | 'orchestratorAgent'
  onToolCall?: (toolCall: StepToolCall) => void
  onToolResult?: (toolResult: StepToolResult) => void
  abortSignal?: AbortSignal
  context?: unknown
}

export type CommandContext = {
  clearMessages: () => void
  session: Session | undefined
  setSession: (session: Session | undefined) => void
  mode: Mode
  setMode: (mode: Mode) => void
  pushMessage: (text: string) => void
  abortController: AbortController
  // openWizard: (mode: WizardMode) => void;
  renderComponent: (component: React.ReactElement | null, message?: string) => void
}

type LocalCommand = {
  type: 'local'
  call(args: string, context: CommandContext): Promise<string | void>
}

type PromptCommand = {
  type: 'prompt'
  progressMessage: string
  getPromptForCommand(args: string): Promise<string>
}

export type Command = {
  name: string
  description: string
  isEnabled: boolean
  isHidden: boolean
  aliases?: string[]
  subcommands?: {
    name: string
    description?: string
  }[]
  userFacingName(): string
} & (LocalCommand | PromptCommand)

export type PermissionDecision = 'allow' | 'allow_session' | 'deny'

export type PermissionRequest = {
  id: string
  toolName: string
  input: unknown
}

export type Skill = {
  description: string
  content: string
}

export interface User {
  name: string
  gender: 'male' | 'female' | 'other'
}
