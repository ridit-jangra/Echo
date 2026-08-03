import { buildProvider, withoutVision } from './providers'
import type { LanguageModel } from 'ai'
import type { ProviderConfig } from './providers'

export async function getModel(): Promise<{
  model: LanguageModel
  modelId: string
  config: ProviderConfig
}> {
  const config: ProviderConfig = {
    model: 'google/gemini-3.1-flash-lite:nitro',
    // model: 'deepseek/deepseek-v4-flash:nitro',
    name: 'openrouter-ig-idk-idc',
    provider: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY
  }
  if (!config) {
    throw new Error('no provider configured')
  }
  return {
    model: withoutVision(buildProvider(config)),
    modelId: `${config.name} · ${config.model}`,
    config
  }
}
