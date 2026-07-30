import WebSocket from 'ws'
import { SERVER_PORT } from '../../shared/constants'

const WAKE_URL = `ws://127.0.0.1:${SERVER_PORT}/wake`
const RECONNECT_MS = 3_000

export function startWakeListener(onWake: () => void): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, RECONNECT_MS)
  }

  const connect = (): void => {
    if (stopped) return
    const ws = new WebSocket(WAKE_URL)
    socket = ws

    ws.onopen = (): void => console.log('[wake] connected to wake-word server')

    ws.onmessage = (event): void => {
      if (String(event.data).trim() === 'wake') onWake()
    }

    ws.onclose = (): void => {
      if (socket === ws) socket = null
      scheduleReconnect()
    }

    ws.onerror = (): void => {
      // server not up yet or dropped — close fires next, which reconnects
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    }
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    socket?.close()
    socket = null
  }
}
