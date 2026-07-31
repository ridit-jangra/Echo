import { execFile } from 'child_process'
import { appendFileSync, statSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { generateText, type LanguageModel } from 'ai'
import { ECHO_BASE_DIR, SCREEN_LOG_DIR, SCREENSHOTS_DIR } from '../../../utils/env'
import { buildProvider } from '../../../utils/providers'
import { getVisionState } from '../argus/agent'
import { startKwinDetector, type ActiveWindow } from './kwin'
import { activateWindow, listWindows, type OpenWindow } from './windows'

const SAMPLE_MS = 60_000
const BUFFER_LIMIT = 60
const LOG_FILE = join(ECHO_BASE_DIR, 'iris-context.jsonl')

// Screen description runs through an OpenRouter VISION model (not the active text
// model). Swap VISION_MODEL for any multimodal OpenRouter model. Calls are gated by
// presence/attention and throttled to keep cost bounded.
const VISION_ENABLED = true
const VISION_MODEL = 'google/gemini-3.1-flash-lite'
const VISION_PROMPT =
  'Describe this screen in detail. State which application or website is in focus and what the user appears to be doing, then cover the key on-screen content: headings, important text, URLs, error messages, names, numbers, and notable UI elements. Quote short but meaningful text verbatim. Write 3 to 6 factual sentences. No preamble, and do not speculate beyond what is visible.'

export type ScreenSample = {
  at: number
  app: string | null
  title: string | null
  description?: string
}

export type ScreenContext = {
  detection: 'kwin' | 'xorg' | 'wayland' | 'degraded'
  visionAvailable: boolean
  current: ScreenSample | null
  recent: ScreenSample[]
}

const buffer: ScreenSample[] = []
let detection: 'kwin' | 'xorg' | 'wayland' | 'degraded' = 'degraded'
let visionModel: LanguageModel | null = null
let kwinWindow: ActiveWindow | null = null

function getVisionModel(): LanguageModel | null {
  if (!process.env.OPENROUTER_API_KEY) return null
  if (!visionModel) {
    visionModel = buildProvider({
      provider: 'openrouter',
      model: VISION_MODEL,
      name: 'iris-vision',
      apiKey: process.env.OPENROUTER_API_KEY
    })
  }
  return visionModel
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim())
    })
  })
}

async function detectViaXprop(): Promise<{ app: string | null; title: string | null }> {
  const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'])
  const wid = root.match(/0x[0-9a-f]+/i)?.[0]
  if (!wid) return { app: null, title: null }
  const props = await run('xprop', ['-id', wid, 'WM_CLASS', '_NET_WM_NAME', 'WM_NAME'])
  if (!props) return { app: null, title: null }
  const classMatch = props.match(/WM_CLASS\(\w+\)\s*=\s*"[^"]*",\s*"([^"]*)"/)
  const nameMatch =
    props.match(/_NET_WM_NAME\(\w+\)\s*=\s*"([^"]*)"/) ||
    props.match(/WM_NAME\(\w+\)\s*=\s*"([^"]*)"/)
  return { app: classMatch?.[1] ?? null, title: nameMatch?.[1] ?? null }
}

async function detectViaHyprctl(): Promise<{ app: string | null; title: string | null }> {
  const out = await run('hyprctl', ['activewindow', '-j'])
  if (!out) return { app: null, title: null }
  try {
    const win = JSON.parse(out) as { class?: string; initialClass?: string; title?: string }
    return { app: win.class || win.initialClass || null, title: win.title || null }
  } catch {
    return { app: null, title: null }
  }
}

async function detectActiveWindow(): Promise<{ app: string | null; title: string | null }> {
  if (kwinWindow && (kwinWindow.app || kwinWindow.title)) {
    detection = 'kwin'
    return kwinWindow
  }
  const xorg = await detectViaXprop()
  if (xorg.app || xorg.title) {
    detection = 'xorg'
    return xorg
  }
  const wayland = await detectViaHyprctl()
  if (wayland.app || wayland.title) {
    detection = 'wayland'
    return wayland
  }
  return { app: null, title: null }
}

type Capturer = { cmd: string; args: (out: string) => string[] }

// Tried in order; first one present and producing a non-empty file wins and is
// cached. Covers KDE (spectacle), GNOME (gnome-screenshot), Wayland (grim),
// and X11 (scrot / maim / ImageMagick import).
const CAPTURERS: Capturer[] = [
  { cmd: 'spectacle', args: (o) => ['-bnf', '-o', o] },
  { cmd: 'gnome-screenshot', args: (o) => ['-f', o] },
  { cmd: 'grim', args: (o) => [o] },
  { cmd: 'scrot', args: (o) => ['-o', o] },
  { cmd: 'maim', args: (o) => [o] },
  { cmd: 'import', args: (o) => ['-window', 'root', o] }
]

let captureCmd: Capturer | null = null

function tryCapture(c: Capturer, outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(c.cmd, c.args(outPath), { timeout: 5000 }, (err) => {
      if (err) return resolve(false)
      try {
        resolve(statSync(outPath).size > 0)
      } catch {
        resolve(false)
      }
    })
  })
}

async function captureScreen(outPath: string): Promise<void> {
  if (captureCmd && (await tryCapture(captureCmd, outPath))) return
  captureCmd = null
  for (const c of CAPTURERS) {
    if (await tryCapture(c, outPath)) {
      captureCmd = c
      return
    }
  }
  throw new Error(`no screenshot tool available (tried ${CAPTURERS.map((c) => c.cmd).join(', ')})`)
}

function screenshotStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function captureToBuffer(): Promise<Buffer | null> {
  await mkdir(SCREENSHOTS_DIR, { recursive: true }).catch(() => {})
  const outPath = join(SCREENSHOTS_DIR, `screen-${screenshotStamp()}.png`)
  try {
    await captureScreen(outPath)
    return await readFile(outPath)
  } catch (err) {
    console.error('[iris] capture failed:', err)
    return null
  }
}

async function captureWindowToBuffer(id: string): Promise<Buffer | null> {
  if (!(await activateWindow(id))) return null
  await new Promise((r) => setTimeout(r, 250))

  await mkdir(SCREENSHOTS_DIR, { recursive: true }).catch(() => {})
  const outPath = join(SCREENSHOTS_DIR, `window-${screenshotStamp()}.png`)
  try {
    const ok = await tryCapture(
      { cmd: 'spectacle', args: (o) => ['-b', '-n', '-a', '-o', o] },
      outPath
    )
    if (!ok) return null
    return await readFile(outPath)
  } catch (err) {
    console.error('[iris] window capture failed:', err)
    return null
  }
}

export async function listOpenWindows(): Promise<OpenWindow[]> {
  return listWindows()
}

export async function describeWindow(
  id: string,
  prompt: string = VISION_PROMPT
): Promise<string | undefined> {
  const image = await captureWindowToBuffer(id)
  if (!image) return undefined
  return describeImage(image, prompt)
}

async function describeImage(image: Buffer, prompt: string): Promise<string | undefined> {
  const model = getVisionModel()
  if (!model) return undefined
  const { text } = await generateText({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image }
        ]
      }
    ]
  })
  return text.trim() || undefined
}

export async function describeScreen(prompt: string = VISION_PROMPT): Promise<string | undefined> {
  const image = await captureToBuffer()
  if (!image) return undefined
  return describeImage(image, prompt)
}

export async function describeImageFile(
  path: string,
  prompt: string = VISION_PROMPT
): Promise<string | undefined> {
  const image = await readFile(path)
  return describeImage(image, prompt)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

async function archiveFrame(sample: ScreenSample, image: Buffer): Promise<void> {
  const d = new Date(sample.at)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const stamp = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  const dir = join(SCREEN_LOG_DIR, date)
  try {
    await mkdir(dir, { recursive: true })
    const base = join(dir, stamp)
    await writeFile(`${base}.png`, image)
    const vision = getVisionState()
    const meta = {
      at: sample.at,
      iso: d.toISOString(),
      date,
      time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      app: sample.app,
      title: sample.title,
      description: sample.description ?? null,
      detection,
      present: vision.present,
      attentive: vision.attentive
    }
    await writeFile(`${base}.json`, JSON.stringify(meta, null, 2), 'utf-8')
  } catch (err) {
    console.error('[iris] archive failed:', err)
  }
}

function record(sample: ScreenSample): void {
  const last = buffer[buffer.length - 1]
  if (last && last.app === sample.app && last.title === sample.title && !sample.description) return
  buffer.push(sample)
  while (buffer.length > BUFFER_LIMIT) buffer.shift()
  try {
    appendFileSync(LOG_FILE, JSON.stringify(sample) + '\n', 'utf-8')
  } catch {
    // best-effort logging only
  }
}

export function getScreenContext(): ScreenContext {
  return {
    detection,
    visionAvailable: Boolean(process.env.OPENROUTER_API_KEY),
    current: buffer[buffer.length - 1] ?? null,
    recent: buffer.slice(-15)
  }
}

export function startIris(): () => void {
  let stopped = false
  let running = false
  let stopKwin: (() => void) | null = null

  void startKwinDetector((w) => {
    kwinWindow = w
  }).then((stop) => {
    if (!stop) return
    if (stopped) stop()
    else stopKwin = stop
  })

  const tick = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      const vision = getVisionState()
      if (vision.available && !vision.present) return

      const { app, title } = await detectActiveWindow()
      const image = await captureToBuffer()

      let description: string | undefined
      if (VISION_ENABLED && image && getVisionModel()) {
        try {
          description = await describeImage(image, VISION_PROMPT)
        } catch (err) {
          console.error('[iris] screen description failed:', err)
        }
      }

      const sample: ScreenSample = { at: Date.now(), app, title, description }
      record(sample)
      if (image) await archiveFrame(sample, image)
    } catch (err) {
      console.error('[iris] sample failed:', err)
    } finally {
      running = false
    }
  }

  void tick()
  const timer = setInterval(() => void tick(), SAMPLE_MS)
  return () => {
    stopped = true
    clearInterval(timer)
    stopKwin?.()
  }
}
