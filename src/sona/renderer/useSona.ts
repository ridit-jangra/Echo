import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

import { synthesize } from './speak'
import { extractSpeakable } from './extractSpeakables'

const MIN_SPEECH_MS = 150

const WAKE_SENTINEL = '<<wake>>'

const MILES_FILLER_DEFAULTS = [
  'let me think',
  'one sec',
  "let's see",
  'give me a moment',
  'hmm, okay'
]
const FILLER_DELAY_MS = 700

const BRIEFED_KEY = 'wake:lastBriefedDate'

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function hasBriefedToday(): boolean {
  try {
    return localStorage.getItem(BRIEFED_KEY) === todayKey()
  } catch {
    return false
  }
}

function markBriefedToday(): void {
  try {
    localStorage.setItem(BRIEFED_KEY, todayKey())
  } catch {
    /* storage disabled */
  }
}

const BARGE_MIN_VOL = 14
const BARGE_MARGIN = 10
const BARGE_SUSTAIN_MS = 350
const BARGE_ARM_MS = 600
const BARGE_CHECK_MS = 500
const BARGE_DEBUG = true

const REPLY_WINDOW_MS = 8_000

const SILENCE_THRESHOLD_MS = 650
const MAX_RECORDING_MS = 25_000
const LISTEN_TICK_MS = 50
const SPEECH_MIN_VOL = 12
const SPEECH_MARGIN = 8
const NOISE_ADAPT = 0.05
const SPEECH_SUSTAIN_TICKS = 3

const HALLUCINATION_PATTERNS = [
  /^(uh+|um+|hm+|hmm+|ah+|eh+)\.?$/i,
  /^thank you\.?$/i,
  /^thanks for watching\.?$/i,
  /^\s*[.,!?]+\s*$/,
  /^[^a-zA-Z0-9]*$/
]

function isGarbage(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true

  return HALLUCINATION_PATTERNS.some((re) => re.test(trimmed))
}

export interface Sona {
  listening: boolean
  thinking: boolean
  speaking: boolean
  transcript: string
  transcriptVisible: boolean
  audioLevel: number
  spokenText: string
  spokenProgress: number
  isPlaying: RefObject<boolean>
  wake: () => void
  sleep: () => void
  stopSpeaking: () => void
}

export function useSona(): Sona {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [transcriptVisible, setTranscriptVisible] = useState(false)
  const [audioLevel, setAudioLevel] = useState(0)
  const [spokenText, setSpokenText] = useState('')
  const [spokenProgress, setSpokenProgress] = useState(0)

  const [thinking, setThinking] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  const mediaRecorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<BlobPart[]>([])
  const isProcessing = useRef(false)
  const transcriptFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const listeningRef = useRef(false)

  const continuousMode = useRef(false)

  const queue = useRef<{ text: string; onDone?: () => void; audio: Promise<ArrayBuffer | null> }[]>(
    []
  )
  const isPlaying = useRef(false)

  const playCtx = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const scheduleCursor = useRef(0)
  const scheduledSources = useRef<AudioBufferSourceNode[]>([])
  const timeline = useRef<{ text: string; start: number; end: number }[]>([])
  const levelRaf = useRef(0)
  const lastCaption = useRef('')
  const pumping = useRef(false)

  const fillerPool = useRef<string[]>(MILES_FILLER_DEFAULTS)

  const bargeStream = useRef<MediaStream | null>(null)
  const bargeCtx = useRef<AudioContext | null>(null)
  const bargeRaf = useRef(0)
  const bargeWanted = useRef(false)
  const bargeChecking = useRef(false)

  const genRef = useRef(0)

  useEffect(() => {
    listeningRef.current = listening
  }, [listening])

  const showTranscript = useCallback((text: string) => {
    if (transcriptFadeTimer.current) {
      clearTimeout(transcriptFadeTimer.current)
      transcriptFadeTimer.current = null
    }
    setTranscript(text)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTranscriptVisible(true))
    })
  }, [])

  const fadeOutTranscript = useCallback(() => {
    setTranscriptVisible(false)
    transcriptFadeTimer.current = setTimeout(() => {
      setTranscript('')
    }, 500)
  }, [])

  const startListeningRef = useRef<((maxWaitMs?: number) => Promise<void>) | null>(null)

  const stopBargeMonitor = useCallback((): void => {
    bargeWanted.current = false
    if (bargeRaf.current) cancelAnimationFrame(bargeRaf.current)
    bargeRaf.current = 0
    bargeStream.current?.getTracks().forEach((t) => t.stop())
    bargeStream.current = null
    bargeCtx.current?.close()
    bargeCtx.current = null
  }, [])

  const ensureCtx = useCallback((): AudioContext => {
    if (!playCtx.current) {
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.connect(ctx.destination)
      playCtx.current = ctx
      analyserRef.current = analyser
    }
    if (playCtx.current.state === 'suspended') void playCtx.current.resume()
    return playCtx.current
  }, [])

  const startLevelLoop = useCallback((): void => {
    if (levelRaf.current) return
    const analyser = analyserRef.current
    if (!analyser) return
    const data = new Uint8Array(analyser.frequencyBinCount)

    const tick = (): void => {
      const ctx = playCtx.current
      if (!ctx || !analyserRef.current) {
        levelRaf.current = 0
        return
      }
      analyserRef.current.getByteFrequencyData(data)
      const volume = data.reduce((a, b) => a + b, 0) / data.length
      setAudioLevel(Math.min(volume / 80, 1))

      const now = ctx.currentTime
      const cur = timeline.current.find((f) => now >= f.start && now < f.end)
      if (cur) {
        if (cur.text !== lastCaption.current) {
          lastCaption.current = cur.text
          setSpokenText(cur.text)
        }
        setSpokenProgress(Math.min((now - cur.start) / (cur.end - cur.start), 1))
      }
      levelRaf.current = requestAnimationFrame(tick)
    }
    levelRaf.current = requestAnimationFrame(tick)
  }, [])

  const stopSpeaking = useCallback((): void => {
    stopBargeMonitor()
    queue.current = []
    scheduledSources.current.forEach((s) => {
      s.onended = null
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
    })
    scheduledSources.current = []
    timeline.current = []
    scheduleCursor.current = 0
    lastCaption.current = ''
    pumping.current = false
    isPlaying.current = false
    if (levelRaf.current) cancelAnimationFrame(levelRaf.current)
    levelRaf.current = 0
    setSpeaking(false)
    setAudioLevel(0)
    setSpokenText('')
  }, [stopBargeMonitor])

  const confirmBargeSpeech = useCallback(
    async (stream: MediaStream): Promise<void> => {
      if (bargeChecking.current) return
      bargeChecking.current = true

      try {
        const chunks: BlobPart[] = []
        const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        const stopped = new Promise<void>((resolve) => {
          recorder.onstop = () => resolve()
        })
        recorder.start()
        await new Promise((resolve) => setTimeout(resolve, BARGE_CHECK_MS))
        if (recorder.state === 'recording') recorder.stop()
        await stopped

        if (!bargeWanted.current || !bargeCtx.current) return

        const blob = new Blob(chunks, { type: 'audio/webm' })
        const arrayBuffer = await blob.arrayBuffer()
        const result = await window.server.transcribe(arrayBuffer)
        const text = result.success ? (result.text?.trim() ?? '') : ''

        if (BARGE_DEBUG) console.log(`[barge] check text=${JSON.stringify(text)}`)

        if (!bargeWanted.current || !bargeCtx.current) return

        if (text && !isGarbage(text)) {
          stopSpeaking()
          startListeningRef.current?.()
        }
      } catch {
        /* treat a failed check as noise — keep speaking */
      } finally {
        bargeChecking.current = false
      }
    },
    [stopSpeaking]
  )

  const startBargeMonitor = useCallback(async (): Promise<void> => {
    if (bargeCtx.current) return

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }
      })
    } catch {
      return
    }

    if (!bargeWanted.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    bargeStream.current = stream
    const ctx = new AudioContext()
    bargeCtx.current = ctx
    if (ctx.state === 'suspended') await ctx.resume()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser)
    const data = new Uint8Array(analyser.frequencyBinCount)

    const armAt = Date.now() + BARGE_ARM_MS
    let voiceStart = 0
    let lastLog = 0
    let noiseFloor = -1

    const tick = (): void => {
      if (!bargeCtx.current) return
      analyser.getByteFrequencyData(data)
      const volume = data.reduce((a, b) => a + b, 0) / data.length

      if (noiseFloor < 0) noiseFloor = Math.min(volume, BARGE_MIN_VOL)
      const threshold = Math.max(BARGE_MIN_VOL, noiseFloor + BARGE_MARGIN)

      if (BARGE_DEBUG && Date.now() - lastLog > 200) {
        lastLog = Date.now()
        console.log(
          `[barge] vol=${volume.toFixed(1)} thr=${threshold.toFixed(1)} floor=${noiseFloor.toFixed(1)} armed=${Date.now() >= armAt} ctx=${ctx.state}`
        )
      }

      if (Date.now() >= armAt && volume > threshold) {
        if (!voiceStart) voiceStart = Date.now()
        else if (Date.now() - voiceStart > BARGE_SUSTAIN_MS && !bargeChecking.current) {
          voiceStart = 0
          void confirmBargeSpeech(stream)
        }
      } else {
        voiceStart = 0
        noiseFloor += NOISE_ADAPT * (volume - noiseFloor)
      }
      bargeRaf.current = requestAnimationFrame(tick)
    }
    bargeRaf.current = requestAnimationFrame(tick)
  }, [confirmBargeSpeech])

  const endOfSpeech = useCallback((): void => {
    isPlaying.current = false
    scheduleCursor.current = 0
    timeline.current = []
    lastCaption.current = ''
    if (levelRaf.current) cancelAnimationFrame(levelRaf.current)
    levelRaf.current = 0
    stopBargeMonitor()
    setSpeaking(false)
    setAudioLevel(0)
    setSpokenProgress(1)
    setTimeout(() => setSpokenText(''), 800)
    fadeOutTranscript()

    if (continuousMode.current) {
      setTimeout(() => startListeningRef.current?.(), 300)
    }
  }, [fadeOutTranscript, stopBargeMonitor])

  const maybeEnd = useCallback((): void => {
    if (
      !pumping.current &&
      queue.current.length === 0 &&
      scheduledSources.current.length === 0 &&
      isPlaying.current
    ) {
      endOfSpeech()
    }
  }, [endOfSpeech])

  const pump = useCallback(async (): Promise<void> => {
    if (pumping.current) return
    pumping.current = true
    const ctx = ensureCtx()

    while (queue.current.length > 0) {
      const item = queue.current.shift()!

      let arr: ArrayBuffer | null = null
      try {
        arr = await item.audio
      } catch {
        arr = null
      }
      if (!isPlaying.current) {
        pumping.current = false
        return
      }
      if (!arr) {
        item.onDone?.()
        continue
      }

      let buf: AudioBuffer
      try {
        buf = await ctx.decodeAudioData(arr.slice(0))
      } catch {
        item.onDone?.()
        continue
      }
      if (!isPlaying.current) {
        pumping.current = false
        return
      }

      const startAt = Math.max(ctx.currentTime + 0.03, scheduleCursor.current)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(analyserRef.current!)
      src.start(startAt)
      scheduledSources.current.push(src)
      timeline.current.push({ text: item.text, start: startAt, end: startAt + buf.duration })
      scheduleCursor.current = startAt + buf.duration

      const onDone = item.onDone
      src.onended = (): void => {
        scheduledSources.current = scheduledSources.current.filter((s) => s !== src)
        onDone?.()
        maybeEnd()
      }
    }

    pumping.current = false
    maybeEnd()
  }, [ensureCtx, maybeEnd])

  const speak = useCallback(
    (text: string, onDone?: () => void): void => {
      queue.current.push({ text, onDone, audio: synthesize(text) })
      if (!isPlaying.current) {
        isPlaying.current = true
        setSpeaking(true)
        setThinking(false)
        bargeWanted.current = true
        startBargeMonitor()
        ensureCtx()
        startLevelLoop()
      }
      void pump()
    },
    [pump, startBargeMonitor, startLevelLoop, ensureCtx]
  )

  const openReplyWindow = useCallback((): void => {
    setTimeout(() => {
      if (
        continuousMode.current ||
        isPlaying.current ||
        listeningRef.current ||
        isProcessing.current
      ) {
        return
      }
      void startListeningRef.current?.(REPLY_WINDOW_MS)
    }, 400)
  }, [])

  useEffect(() => {
    const off = window.speak?.onSay((text: string, listen: boolean) => {
      const trimmed = text?.trim()
      if (trimmed) speak(trimmed, listen ? openReplyWindow : undefined)
    })
    return off
  }, [speak, openReplyWindow])

  useEffect(() => {
    const off = window.filler?.onUpdate((agent: string, pool: string[]) => {
      if (agent === 'miles' && pool.length) fillerPool.current = pool
    })
    return off
  }, [])

  const getMilesFiller = useCallback((): string => {
    const pool = fillerPool.current
    return pool[Math.floor(Math.random() * pool.length)]
  }, [])

  useEffect(() => {
    return () => {
      if (transcriptFadeTimer.current) clearTimeout(transcriptFadeTimer.current)
      if (levelRaf.current) cancelAnimationFrame(levelRaf.current)
      scheduledSources.current.forEach((s) => {
        s.onended = null
        try {
          s.stop()
        } catch {
          /* already stopped */
        }
      })
      playCtx.current?.close()
      if (bargeRaf.current) cancelAnimationFrame(bargeRaf.current)
      bargeStream.current?.getTracks().forEach((t) => t.stop())
      bargeCtx.current?.close()
    }
  }, [])

  const handleStreamComplete = useCallback(
    (_fullText: string, remainder: string) => {
      const leftover = remainder.trim()
      if (leftover) speak(leftover)
    },
    [speak]
  )

  const chatStreaming = useCallback(
    async (userText: string): Promise<void> => {
      const myGen = ++genRef.current
      let buffer = ''
      let spokenYet = false

      const fillerTimer = setTimeout(() => {
        if (genRef.current === myGen && !spokenYet) speak(getMilesFiller())
      }, FILLER_DELAY_MS)

      const removeListener = window.ai.onChunk((delta: string) => {
        if (genRef.current !== myGen) return
        buffer += delta
        const [sentences, remaining] = spokenYet
          ? extractSpeakable(buffer)
          : extractSpeakable(buffer, 3, 4)
        if (sentences) {
          clearTimeout(fillerTimer)
          speak(sentences)
          spokenYet = true
        }
        buffer = remaining
      })

      try {
        const fullText: string = await window.ai.chatStream(userText)
        clearTimeout(fillerTimer)
        removeListener()
        if (genRef.current === myGen) handleStreamComplete(fullText, buffer)
        window.filler?.requestRefresh(
          'miles',
          `Sir said: "${userText}"\nMiles replied: "${fullText.slice(0, 300)}"`
        )
      } catch (e) {
        clearTimeout(fillerTimer)
        removeListener()

        setThinking(false)
        console.error('[Miles] streaming failed:', e)
      }
    },
    [speak, handleStreamComplete, getMilesFiller]
  )

  const startListening = useCallback(
    async (maxWaitMs?: number): Promise<void> => {
      if (isProcessing.current || listeningRef.current || isPlaying.current) return

      genRef.current++
      setThinking(false)

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        console.error('[Miles] mic access denied')
        return
      }

      setTranscript('')
      setTranscriptVisible(false)

      mediaRecorder.current = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      })
      chunks.current = []

      let awaitingSpecFlush = false
      let specTranscribe: ReturnType<typeof window.server.transcribe> | null = null

      mediaRecorder.current.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.current.push(e.data)
        if (awaitingSpecFlush) {
          awaitingSpecFlush = false
          const blob = new Blob(chunks.current, { type: 'audio/webm' })
          specTranscribe = blob.arrayBuffer().then((buf) => window.server.transcribe(buf))
        }
      }

      const audioCtx = new AudioContext()
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)

      let silenceStart = Date.now()
      let spokenOnce = false
      let firstSoundAt = 0
      let lastSoundAt = 0
      let noiseFloor = -1
      let loudTicks = 0
      const openedAt = Date.now()

      const recorder = mediaRecorder.current

      const cleanup = (): void => {
        clearInterval(listenTimer)
        stream.getTracks().forEach((t) => t.stop())
        void audioCtx.close()
      }

      const listenTimer = setInterval(() => {
        if (recorder.state !== 'recording') {
          cleanup()
          return
        }

        if (maxWaitMs && !spokenOnce && Date.now() - openedAt > maxWaitMs) {
          cleanup()
          recorder.stop()
          return
        }

        // Failsafe: intermittent background noise (fans, clicks, chatter) can keep
        // re-triggering the "loud" branch below and endlessly reset the silence
        // timer, so recording never naturally stops. This guarantees it always does.
        if (Date.now() - openedAt > MAX_RECORDING_MS) {
          cleanup()
          recorder.stop()
          return
        }

        analyser.getByteFrequencyData(data)
        const volume = data.reduce((a, b) => a + b, 0) / data.length

        if (noiseFloor < 0) noiseFloor = Math.min(volume, SPEECH_MIN_VOL)
        const threshold = Math.max(SPEECH_MIN_VOL, noiseFloor + SPEECH_MARGIN)

        if (volume > threshold) {
          loudTicks++
          if (loudTicks >= SPEECH_SUSTAIN_TICKS) {
            if (!spokenOnce) firstSoundAt = Date.now()
            spokenOnce = true
            lastSoundAt = Date.now()
            silenceStart = Date.now()
            awaitingSpecFlush = false
            specTranscribe = null
          }
        } else {
          loudTicks = 0
          noiseFloor += NOISE_ADAPT * (volume - noiseFloor)
          if (spokenOnce) {
            const silenceMs = Date.now() - silenceStart
            if (!awaitingSpecFlush && !specTranscribe && silenceMs > SILENCE_THRESHOLD_MS / 2) {
              awaitingSpecFlush = true
              recorder.requestData()
            }
            if (silenceMs > SILENCE_THRESHOLD_MS) {
              cleanup()
              recorder.stop()
            }
          }
        }
      }, LISTEN_TICK_MS)

      mediaRecorder.current.onstop = async () => {
        isProcessing.current = true

        const speechMs = spokenOnce ? lastSoundAt - firstSoundAt : 0
        try {
          const result = specTranscribe
            ? await specTranscribe
            : await (async () => {
                const blob = new Blob(chunks.current, { type: 'audio/webm' })
                const arrayBuffer = await blob.arrayBuffer()
                return window.server.transcribe(arrayBuffer)
              })()
          const text = result.success ? (result.text?.trim() ?? '') : ''
          const tone = result.tone
          console.log(`[Miles] tone: ${tone ?? 'none'} — ${JSON.stringify(text)}`)

          const tooShort = speechMs < MIN_SPEECH_MS
          if (!text || tooShort || isGarbage(text)) {
            console.log(
              '[Miles] ignored:',
              JSON.stringify(text),
              `(speech ${speechMs}ms${tooShort ? ', too short' : ''})`
            )
            if (continuousMode.current) {
              setTimeout(() => startListeningRef.current?.(), 200)
            }
            return
          }

          showTranscript(text)

          continuousMode.current = true
          setThinking(true)
          bargeWanted.current = true
          startBargeMonitor()
          chatStreaming(tone && tone !== 'neutral' ? `[tone: ${tone}] ${text}` : text)
        } catch (e) {
          console.error('[Miles] transcription failed:', e)
          setThinking(false)

          if (continuousMode.current) {
            setTimeout(() => startListeningRef.current?.(), 1000)
          }
        } finally {
          isProcessing.current = false
          setListening(false)
        }
      }

      mediaRecorder.current.start()
      setListening(true)
    },
    [chatStreaming, showTranscript, startBargeMonitor]
  )

  useEffect(() => {
    startListeningRef.current = startListening
  }, [startListening])

  const wake = useCallback((): void => {
    if (continuousMode.current) return
    continuousMode.current = true

    if (hasBriefedToday()) {
      startListeningRef.current?.()
      return
    }
    markBriefedToday()

    setThinking(true)
    bargeWanted.current = true
    startBargeMonitor()
    void chatStreaming(WAKE_SENTINEL).finally(() => {
      if (!isPlaying.current) {
        setThinking(false)
        stopBargeMonitor()
        startListeningRef.current?.()
      }
    })
  }, [chatStreaming, startBargeMonitor, stopBargeMonitor])

  const wakeRef = useRef(wake)
  useEffect(() => {
    wakeRef.current = wake
  }, [wake])

  useEffect(() => {
    const off = window.wake?.onTrigger(() => wakeRef.current())
    return off
  }, [])

  const sleep = useCallback((): void => {
    continuousMode.current = false
    setThinking(false)
    stopBargeMonitor()
    mediaRecorder.current?.stop()
  }, [stopBargeMonitor])

  useEffect(() => {
    const off = window.dnd?.onEnter(() => {
      continuousMode.current = false
    })
    return off
  }, [])

  return {
    listening,
    thinking,
    speaking,
    transcript,
    transcriptVisible,
    audioLevel,
    spokenText,
    spokenProgress,
    isPlaying,
    wake,
    sleep,
    stopSpeaking
  }
}
