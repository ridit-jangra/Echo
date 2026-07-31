import { MemoryEditTool } from '../tools/MemoryEditTool/tool'
import { MemoryReadTool } from '../tools/MemoryReadTool/tool'
import { MemoryWriteTool } from '../tools/MemoryWriteTool/tool'
import { ThinkTool } from '../tools/ThinkTool/tool'
import { HumanEditTool } from '../tools/HumanEditTool/tool'
import { SubagentTool } from '../tools/SubagentTool/tool'
import { CheckAgentsTool } from '../tools/CheckAgentsTool/tool'
import { SubscribeTool } from '../tools/SubscribeTool/tool'
import { PlanTool } from '../tools/PlanTool/tool'
import { ScreenshotTool } from '../tools/ScreenshotTool/tool'
import { ScreenLogTool } from '../tools/ScreenLogTool/tool'
import { InspectFrameTool } from '../tools/InspectFrameTool/tool'
import { AppScreenshotTool } from '../tools/AppScreenshotTool/tool'
import { ScreenRecordTool } from '../tools/ScreenRecordTool/tool'

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
  ScreenshotTool,
  ScreenLogTool,
  InspectFrameTool,
  AppScreenshotTool,
  ScreenRecordTool
}

export const chatTools = {
  MemoryReadTool,
  HumanEditTool,
  ScreenshotTool,
  ScreenLogTool,
  InspectFrameTool,
  AppScreenshotTool,
  ScreenRecordTool
}
