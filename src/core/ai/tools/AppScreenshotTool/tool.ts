import { tool } from 'ai'
import { z } from 'zod'
import { describeWindow, listOpenWindows } from '../../agents/custom-agents/iris/agent'
import { DESCRIPTION, PROMPT } from './prompt'

const inputSchema = z.object({
  action: z.enum(['list', 'capture']).describe('list open windows, or capture a screenshot of one'),
  app: z
    .string()
    .optional()
    .describe(
      'For action=capture: which open window to screenshot, matched case-insensitively against the app name or window title. Required for capture.'
    ),
  focus: z
    .string()
    .optional()
    .describe("What to look for in that window, e.g. 'read the error message'")
})

const READ_PROMPT =
  'Look at this screenshot of one specific application window and answer clearly and factually. Read any relevant on-screen text (errors, messages, code, dialogs) verbatim when it matters. No preamble.'

type WindowSummary = { app: string; title: string }

type AppScreenshotResult = {
  success: boolean
  error?: string
  windows?: WindowSummary[]
  app?: string
  title?: string
  description?: string
}

export const AppScreenshotTool = tool({
  title: 'App Screenshot',
  description: DESCRIPTION + '\n\n' + PROMPT,
  inputSchema,
  execute: async ({ action, app, focus }): Promise<AppScreenshotResult> => {
    const windows = await listOpenWindows()

    if (action === 'list') {
      if (windows.length === 0) {
        return {
          success: false,
          error: 'No open windows found (or window listing is unavailable on this system).'
        }
      }
      return { success: true, windows: windows.map((w) => ({ app: w.app, title: w.title })) }
    }

    if (!app) return { success: false, error: 'capture needs "app" — which window to screenshot.' }

    const needle = app.toLowerCase()
    const matches = windows.filter(
      (w) => w.app.toLowerCase().includes(needle) || w.title.toLowerCase().includes(needle)
    )

    if (matches.length === 0) {
      return {
        success: false,
        error: `No open window matches "${app}".`,
        windows: windows.map((w) => ({ app: w.app, title: w.title }))
      }
    }
    if (matches.length > 1) {
      return {
        success: false,
        error: `"${app}" matches more than one window — be more specific.`,
        windows: matches.map((w) => ({ app: w.app, title: w.title }))
      }
    }

    const target = matches[0]
    const prompt = focus ? `${READ_PROMPT}\n\nSir is asking: ${focus}` : READ_PROMPT
    const description = await describeWindow(target.id, prompt)
    if (!description) {
      return {
        success: false,
        error: `Could not capture "${target.app}" — screenshot tool or vision model unavailable.`
      }
    }
    return { success: true, app: target.app, title: target.title, description }
  },
  toModelOutput: ({ output }) => {
    if (!output.success) {
      const extra = output.windows?.length
        ? ` Open windows: ${output.windows.map((w) => `${w.app} (${w.title})`).join(', ')}`
        : ''
      return { type: 'content', value: [{ type: 'text', text: `${output.error}${extra}` }] }
    }
    if (output.description) {
      return { type: 'content', value: [{ type: 'text', text: `${output.app}: ${output.description}` }] }
    }
    return {
      type: 'content',
      value: [
        {
          type: 'text',
          text: (output.windows ?? []).map((w) => `${w.app}: ${w.title}`).join('\n') || 'No windows open.'
        }
      ]
    }
  }
})
