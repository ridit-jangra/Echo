import { ElectronAPI } from '@electron-toolkit/preload'
import type { MCPServerInput, MCPServerState, MCPServerUpdate } from '../shared/mcp'
import type { GithubDeviceStart, SlackOAuthResult } from '../shared/oauth'
import type { Briefing } from '../shared/briefing'
import type { EventAlert } from '../shared/events'
import type { AppSettings } from '../shared/settings'

type server_api = {
  transcribe: (buffer: ArrayBuffer) => Promise<{
    success: boolean
    text: string
    tone?: string
  }>
  speak: (text: string) => Promise<{
    success: boolean
    audio: BlobPart
  }>
}

type ai_api = {
  chat: (text: string) => Promise<string>
  chatStream: (text: string) => Promise<string>
  onChunk: (cb: (delta: string) => void) => () => void
}

type mcp_api = {
  list: () => Promise<MCPServerState[]>
  add: (config: MCPServerInput) => Promise<MCPServerState>
  update: (id: string, patch: MCPServerUpdate) => Promise<MCPServerState>
  remove: (id: string) => Promise<void>
  connect: (id: string) => Promise<MCPServerState>
  disconnect: (id: string) => Promise<MCPServerState>
}

type oauth_api = {
  githubStart: () => Promise<GithubDeviceStart>
  githubPoll: (deviceCode: string, interval: number) => Promise<string>
  slack: () => Promise<SlackOAuthResult>
}

type briefing_api = {
  get: () => Promise<Briefing>
}

type settings_api = {
  get: () => Promise<AppSettings>
  set: (patch: Partial<AppSettings>) => Promise<void>
}

declare global {
  interface Window {
    electron: ElectronAPI
    server: server_api
    ai: ai_api
    mcp: mcp_api
    oauth: oauth_api
    briefing: briefing_api
    settings: settings_api
    speak: { onSay: (cb: (text: string, listen: boolean) => void) => () => void }
    filler: {
      onUpdate: (cb: (agent: string, pool: string[]) => void) => () => void
      requestRefresh: (agent: string, context: string) => void
    }
    wake: { onTrigger: (cb: () => void) => () => void }
    dnd: { onEnter: (cb: () => void) => () => void }
    events: { onAlert: (cb: (alert: EventAlert) => void) => () => void }
    env: {
      WEATHER_API_KEY: string
      NEWS_API_KEY: string
    }
  }
}

export type {
  MCPServerInput,
  MCPServerState,
  MCPServerUpdate,
  GithubDeviceStart,
  SlackOAuthResult,
  Briefing
}
