import { tool } from 'ai'
import { z } from 'zod'
import { SERVER_URL, SERVER_PORT } from '../../../../shared/constants'
import { DESCRIPTION, PROMPT } from './prompt'

const BASE = `${SERVER_URL}:${SERVER_PORT}/screencast`

const inputSchema = z.object({
  action: z.enum(['start', 'stop']).describe('start or stop the recording'),
  target: z
    .enum(['screen', 'window'])
    .optional()
    .describe(
      'For action=start: "screen" for the full display, "window" to let sir pick one open window in the picker. Defaults to "screen".'
    )
})

export const ScreenRecordTool = tool({
  title: 'Screen Record',
  description: DESCRIPTION + '\n\n' + PROMPT,
  inputSchema,
  execute: async ({ action, target }) => {
    try {
      if (action === 'start') {
        const res = await fetch(`${BASE}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: target ?? 'screen' })
        })
        const data = (await res.json()) as { success: boolean; error?: string; detail?: string }
        if (!data.success) {
          const detail = data.error ?? data.detail ?? `HTTP ${res.status}`
          return { success: false, error: `Could not start recording: ${detail}` }
        }
        return { success: true, message: `Recording started (${target ?? 'screen'}).` }
      }

      const res = await fetch(`${BASE}/stop`, { method: 'POST' })
      const data = (await res.json()) as {
        success: boolean
        error?: string
        detail?: string
        output_path?: string
        seconds?: number
      }
      if (!data.success) {
        const detail = data.error ?? data.detail ?? `HTTP ${res.status}`
        return { success: false, error: `Could not stop recording: ${detail}` }
      }
      return { success: true, outputPath: data.output_path, seconds: data.seconds }
    } catch (err) {
      return { success: false, error: `Screen recorder unreachable: ${String(err)}` }
    }
  },
  toModelOutput: ({ output }) => {
    if (!output.success) {
      return {
        type: 'content',
        value: [{ type: 'text', text: output.error ?? 'Recording failed.' }]
      }
    }
    if (output.outputPath) {
      return {
        type: 'content',
        value: [
          { type: 'text', text: `Saved ${output.seconds}s recording to ${output.outputPath}` }
        ]
      }
    }
    return {
      type: 'content',
      value: [{ type: 'text', text: output.message ?? 'Recording started.' }]
    }
  }
})
