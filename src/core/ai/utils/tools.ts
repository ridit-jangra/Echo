import { MemoryEditTool } from '../tools/MemoryEditTool/tool'
import { MemoryReadTool } from '../tools/MemoryReadTool/tool'
import { MemoryWriteTool } from '../tools/MemoryWriteTool/tool'
import { ThinkTool } from '../tools/ThinkTool/tool'
import { HumanEditTool } from '../tools/HumanEditTool/tool'
import { SubagentTool } from '../tools/SubagentTool/tool'
import { CheckAgentsTool } from '../tools/CheckAgentsTool/tool'
import { SubscribeTool } from '../tools/SubscribeTool/tool'
import { PlanTool } from '../tools/PlanTool/tool'
import { ScreenLogTool } from '../tools/ScreenLogTool/tool'
import { InspectFrameTool } from '../tools/InspectFrameTool/tool'
import { ScreenRecordTool } from '../tools/ScreenRecordTool/tool'

// ScreenshotTool and AppScreenshotTool are deliberately NOT here — they save
// into ~/.echo/screenshots, and only Miles' own root chat (index.ts) should
// be able to write there. Subagents that spread agentTools (merlin, hank)
// must not get them.
export const agentTools = {
  MemoryReadTool,
  MemoryWriteTool,
  MemoryEditTool,
  ThinkTool,
  HumanEditTool,
  SubagentTool,
  CheckAgentsTool,
  SubscribeTool,
  PlanTool,
  ScreenLogTool,
  InspectFrameTool,
  ScreenRecordTool
}

export const chatTools = {
  MemoryReadTool,
  HumanEditTool,
  ScreenLogTool,
  InspectFrameTool,
  ScreenRecordTool
}
