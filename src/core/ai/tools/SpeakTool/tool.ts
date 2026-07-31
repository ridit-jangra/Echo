import { tool } from 'ai'
import { z } from 'zod'
import { say } from '../../../events/speech'
import { DESCRIPTION, PROMPT } from './prompt'

export const SpeakTool = tool({
  title: 'Speak',
  description: DESCRIPTION + '\n\n' + PROMPT,
  inputSchema: z.object({
    text: z.string().describe('One short, natural spoken sentence to say out loud right now')
  }),
  execute: async ({ text }) => {
    const spoken = say(text)
    if (!spoken) {
      return {
        success: false,
        skipped:
          'Not spoken: too soon after another heads-up, or too similar to one already said. Stay silent and just make the next tool call.'
      }
    }
    return { success: true, spoken: text }
  }
})
