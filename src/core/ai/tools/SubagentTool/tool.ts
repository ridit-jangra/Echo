import { tool } from 'ai'
import { z } from 'zod'
import { chatStream as dexter } from '../../agents/custom-agents/dexter/agent'
import { chatStream as hank } from '../../agents/custom-agents/hank/agent'
import { chatStream as merlin } from '../../agents/custom-agents/merlin/agent'
import { chatStream as scout } from '../../agents/custom-agents/scout/agent'
import { chatStream as otto } from '../../agents/custom-agents/otto/agent'
import { say, msSinceLastSpoken } from '../../../events/speech'
import {
  recordSubagentResult,
  startSubagentRun,
  appendSubagentActivity,
  completeSubagentRun,
  getSubagentRun,
  getSubagentSignal
} from '../../../events/subagents'
import { narrateSubagentResult } from '../../../events/narrate'
import { getFiller, refreshFillerPool } from '../../../events/fillers'
import { DESCRIPTION, PROMPT } from './prompt'

const AGENTS = { dexter, hank, merlin, scout, otto } as const

// If sir just heard something (e.g. the model slipped a SpeakTool heads-up in right
// before delegating, despite being told not to), a second filler line on top of it
// reads as talking over itself — so only speak ours when the air's actually silent.
const RECENT_SPEECH_SKIP_MS = 10_000

export const SubagentTool = tool({
  title: 'Subagent',
  description: DESCRIPTION + '\n\n' + PROMPT,
  inputSchema: z.object({
    agent: z
      .enum(['dexter', 'hank', 'merlin', 'scout', 'otto'])
      .describe('Which subagent to delegate to, chosen by lane'),
    task: z.string().describe('A clear, self-contained instruction for the subagent to carry out')
  }),
  execute: async ({ agent, task }) => {
    const runId = startSubagentRun(agent, task)
    if (msSinceLastSpoken() > RECENT_SPEECH_SKIP_MS) say(getFiller(agent), false)
    void AGENTS[agent](
      task,
      (delta) => appendSubagentActivity(runId, delta),
      getSubagentSignal(runId)
    )
      .then(async ({ text }) => {
        refreshFillerPool(agent, `Just finished: ${task}`)
        if (getSubagentRun(runId)?.status === 'killed') return
        completeSubagentRun(runId, true)
        recordSubagentResult({ agent, task, result: text, ok: true })
        say(await narrateSubagentResult(agent, task, text))
      })
      .catch((err) => {
        if (getSubagentRun(runId)?.status === 'killed') {
          recordSubagentResult({
            agent,
            task,
            result: 'Killed at sir’s request before finishing. It will not report back.',
            ok: false
          })
          return
        }
        completeSubagentRun(runId, false)
        const message = err instanceof Error ? err.message : String(err)
        recordSubagentResult({ agent, task, result: `Failed: ${message}`, ok: false })
        say(`${agent} ran into a problem with that, sir.`)
        console.error(`[Subagent ${agent}] background task failed:`, err)
      })

    return {
      success: true,
      agent,
      status: 'running',
      note: `${agent} is handling that in the background. ${agent} owns the talking for this task: it voices its own progress notes while working and its final result is spoken aloud automatically the moment it finishes (and dropped into your context as a subagent_result). So do NOT speak any status line of your own now — don't say it's done, don't say it's searching, don't narrate progress, don't end your turn with a completion sentence. Stay quiet on this task and let ${agent} report; only if sir directly asks, say ${agent} is still on it. Premature or guessed status from you will contradict ${agent}'s own voice and confuse sir.`
    }
  }
})
