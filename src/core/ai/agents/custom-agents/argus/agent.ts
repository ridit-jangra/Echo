import WebSocket from 'ws'
import { SERVER_PORT } from '../../../../../shared/constants'
import { setPresent } from '../../../../events/announcements'
import { say } from '../../../../events/speech'

const VISION_URL = `ws://127.0.0.1:${SERVER_PORT}/vision`
const RECONNECT_MS = 5_000
const SURFER_COOLDOWN_MS = 60_000

export type VisionState = {
  available: boolean
  present: boolean
  attentive: boolean | null
  faces: number
  known: string[]
  unknown: number
  enrolled: boolean
  lastGesture: string | null
  hand: { x: number; y: number; pinch: boolean } | null
}

let handHandler: ((hand: { x: number; y: number; pinch: boolean } | null) => void) | null = null

export function setHandHandler(
  fn: (hand: { x: number; y: number; pinch: boolean } | null) => void
): void {
  handHandler = fn
}

// const WAVE_COOLDOWN_MS = 5_000
// let lastWaveAt = 0
// let gestureHandler: ((gesture: string) => void) | null = null

// export function setGestureHandler(fn: (gesture: string) => void): void {
//   gestureHandler = fn
// }

const state: VisionState = {
  available: false,
  present: false,
  attentive: null,
  faces: 0,
  known: [],
  unknown: 0,
  enrolled: false,
  lastGesture: null,
  hand: null
}

let lastSurferWarnAt = 0

export function getVisionState(): VisionState {
  return { ...state }
}

function onEvent(event: Record<string, unknown>): void {
  switch (event.type) {
    case 'state': {
      Object.assign(state, {
        available: event.available ?? state.available,
        present: event.present ?? state.present,
        attentive: event.attentive ?? state.attentive,
        faces: event.faces ?? state.faces,
        known: event.known ?? state.known,
        unknown: event.unknown ?? state.unknown,
        enrolled: event.enrolled ?? state.enrolled
      })
      setPresent(state.present)
      break
    }
    case 'camera': {
      state.available = Boolean(event.available)
      console.log(`[argus] camera ${state.available ? 'online' : 'offline'}`)
      if (!state.available) setPresent(true)
      break
    }
    case 'presence': {
      state.present = Boolean(event.present)
      setPresent(state.present)
      console.log(`[argus] ${state.present ? 'sir arrived' : 'sir left'}`)
      break
    }
    case 'attention': {
      state.attentive = event.attentive === null ? null : Boolean(event.attentive)
      break
    }
    case 'privacy': {
      state.known = (event.known as string[]) ?? []
      state.unknown = Number(event.unknown ?? 0)
      state.faces = Number(event.faces ?? state.faces)
      if (state.unknown > 0 && state.known.length > 0) {
        const now = Date.now()
        if (now - lastSurferWarnAt > SURFER_COOLDOWN_MS) {
          lastSurferWarnAt = now
          console.log('[argus] shoulder surfer detected')
          say('Heads up sir, someone I don’t recognize is behind you.')
        }
      }
      break
    }
    case 'hand': {
      if (event.present) {
        state.hand = {
          x: Number(event.x ?? 0),
          y: Number(event.y ?? 0),
          pinch: Boolean(event.pinch)
        }
      } else {
        state.hand = null
      }
      handHandler?.(state.hand)
      break
    }
    case 'gesture': {
      const gesture = String(event.gesture ?? '')
      state.lastGesture = gesture
      // if (gesture === 'wave') {
      //   const now = Date.now()
      //   if (now - lastWaveAt > WAVE_COOLDOWN_MS) {
      //     lastWaveAt = now
      //     state.present = true
      //     setPresent(true)
      //     console.log('[argus] wave detected')
      //     say('Yes sir?')
      //     gestureHandler?.(gesture)
      //   }
      // }
      break
    }
    case 'enrolled':
      state.enrolled = true
      console.log(`[argus] enrolled ${event.name}`)
      break
    case 'calibrated':
      console.log(`[argus] attention calibrated`)
      break
    case 'enroll_failed':
      console.log(`[argus] enroll failed for ${event.name}: ${event.reason}`)
      break
    case 'calibrate_failed':
      console.log(`[argus] calibrate failed: ${event.reason}`)
      break
  }
}

export function startArgus(): () => void {
  let stopped = false
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const connect = (): void => {
    if (stopped) return
    try {
      socket = new WebSocket(VISION_URL)
    } catch (err) {
      console.error('[argus] socket construction failed:', err)
      scheduleReconnect()
      return
    }

    socket.addEventListener('message', (ev) => {
      try {
        onEvent(JSON.parse(String((ev as MessageEvent).data)))
      } catch {
        // ignore malformed frames
      }
    })
    socket.addEventListener('close', () => {
      setPresent(true)
      scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      try {
        socket?.close()
      } catch {
        // already closing
      }
    })
  }

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, RECONNECT_MS)
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    setPresent(true)
    try {
      socket?.close()
    } catch {
      // already closed
    }
  }
}
