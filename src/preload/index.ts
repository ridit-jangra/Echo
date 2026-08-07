/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  BRIEFING_GET,
  CHAT,
  CHAT_CHUNK,
  CHAT_STREAM,
  GITHUB_OAUTH_POLL,
  GITHUB_OAUTH_START,
  SLACK_OAUTH,
  MCP_ADD,
  MCP_CONNECT,
  MCP_DISCONNECT,
  MCP_LIST,
  MCP_REMOVE,
  MCP_UPDATE,
  SETTINGS_GET,
  SETTINGS_SET,
  SPEAK,
  TRANSCRIBE,
  EVENT_ALERT,
  WAKE_TRIGGER,
  DND_ENTERED,
  FILLER_UPDATE,
  FILLER_REFRESH
} from '../shared/channels'
import type { MCPServerInput, MCPServerState, MCPServerUpdate } from '../shared/mcp'
import type { GithubDeviceStart, SlackOAuthResult } from '../shared/oauth'
import type { Briefing } from '../shared/briefing'
import type { EventAlert } from '../shared/events'
import type { AppSettings } from '../shared/settings'

const server = {
  transcribe: (
    audioBuffer: ArrayBuffer
  ): Promise<{ success: boolean; text: string; tone?: string }> =>
    ipcRenderer.invoke(TRANSCRIBE, audioBuffer),

  speak: (text: string): Promise<{ success: boolean; audio: ArrayBuffer | null }> =>
    ipcRenderer.invoke(SPEAK, text)
}

const ai = {
  chat: (text: string) => ipcRenderer.invoke(CHAT, text),
  chatStream: (text: string): Promise<string> => ipcRenderer.invoke(CHAT_STREAM, text),

  onChunk: (cb: (delta: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, delta: string): void => cb(delta)
    ipcRenderer.on(CHAT_CHUNK, handler)
    return () => ipcRenderer.removeListener(CHAT_CHUNK, handler)
  }
}

const mcp = {
  list: (): Promise<MCPServerState[]> => ipcRenderer.invoke(MCP_LIST),

  add: (config: MCPServerInput): Promise<MCPServerState> => ipcRenderer.invoke(MCP_ADD, config),

  update: (id: string, patch: MCPServerUpdate): Promise<MCPServerState> =>
    ipcRenderer.invoke(MCP_UPDATE, id, patch),

  remove: (id: string): Promise<void> => ipcRenderer.invoke(MCP_REMOVE, id),

  connect: (id: string): Promise<MCPServerState> => ipcRenderer.invoke(MCP_CONNECT, id),

  disconnect: (id: string): Promise<MCPServerState> => ipcRenderer.invoke(MCP_DISCONNECT, id)
}

const oauth = {
  githubStart: (): Promise<GithubDeviceStart> => ipcRenderer.invoke(GITHUB_OAUTH_START),

  githubPoll: (deviceCode: string, interval: number): Promise<string> =>
    ipcRenderer.invoke(GITHUB_OAUTH_POLL, deviceCode, interval),

  slack: (): Promise<SlackOAuthResult> => ipcRenderer.invoke(SLACK_OAUTH)
}

const briefing = {
  get: (): Promise<Briefing> => ipcRenderer.invoke(BRIEFING_GET)
}

const settings = {
  get: (): Promise<AppSettings> => ipcRenderer.invoke(SETTINGS_GET),

  set: (patch: Partial<AppSettings>): Promise<void> => ipcRenderer.invoke(SETTINGS_SET, patch)
}

const events = {
  onAlert: (cb: (alert: EventAlert) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, alert: EventAlert): void => cb(alert)
    ipcRenderer.on(EVENT_ALERT, handler)
    return () => ipcRenderer.removeListener(EVENT_ALERT, handler)
  }
}

const speak = {
  onSay: (cb: (text: string, listen: boolean) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, text: string, listen: boolean) =>
      cb(text, listen === true)
    ipcRenderer.on('speak:say', handler)
    return () => ipcRenderer.removeListener('speak:say', handler)
  }
}

const wake = {
  onTrigger: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on(WAKE_TRIGGER, handler)
    return () => ipcRenderer.removeListener(WAKE_TRIGGER, handler)
  }
}

const dnd = {
  onEnter: (cb: () => void) => {
    const handler = (): void => cb()
    ipcRenderer.on(DND_ENTERED, handler)
    return () => ipcRenderer.removeListener(DND_ENTERED, handler)
  }
}

const filler = {
  onUpdate: (cb: (agent: string, pool: string[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, agent: string, pool: string[]): void =>
      cb(agent, pool)
    ipcRenderer.on(FILLER_UPDATE, handler)
    return () => ipcRenderer.removeListener(FILLER_UPDATE, handler)
  },
  requestRefresh: (agent: string, context: string): void => {
    ipcRenderer.send(FILLER_REFRESH, agent, context)
  }
}

contextBridge.exposeInMainWorld('env', {
  WEATHER_API_KEY: process.env.WEATHER_API_KEY ?? '',
  NEWS_API_KEY: process.env.NEWS_API_KEY ?? ''
})

try {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('server', server)
  contextBridge.exposeInMainWorld('ai', ai)
  contextBridge.exposeInMainWorld('mcp', mcp)
  contextBridge.exposeInMainWorld('oauth', oauth)
  contextBridge.exposeInMainWorld('briefing', briefing)
  contextBridge.exposeInMainWorld('settings', settings)
  contextBridge.exposeInMainWorld('speak', speak)
  contextBridge.exposeInMainWorld('filler', filler)
  contextBridge.exposeInMainWorld('wake', wake)
  contextBridge.exposeInMainWorld('dnd', dnd)
  contextBridge.exposeInMainWorld('events', events)
} catch (error) {
  console.error(error)
}
