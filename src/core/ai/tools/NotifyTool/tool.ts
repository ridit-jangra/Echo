import { tool } from 'ai'
import { z } from 'zod'
import { say } from '../../../events/speech'
import { noteProactiveSpoken } from '../../../events/proactive-log'
import { DESCRIPTION, PROMPT } from './prompt'

export const NotifyTool = tool({
  title: 'Notify',
  description: DESCRIPTION + '\n\n' + PROMPT,
  inputSchema: z.object({
    message: z
      .string()
      .describe("A short, natural progress heads-up for sir, relayed aloud in Miles's voice")
  }),
  execute: async ({ message }) => {
    say(message)
    noteProactiveSpoken(message)
    return { success: true, notified: message }
  }
})
