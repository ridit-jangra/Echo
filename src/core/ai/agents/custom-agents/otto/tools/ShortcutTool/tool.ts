import { tool } from 'ai'
import { z } from 'zod'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { ECHO_BASE_DIR } from '../../../../../utils/env'
import { PersistentShell } from '../../../../../utils/PersistentShell'
import { scanCommandForProtected } from '../../../../../utils/protectedPaths'
import { BANNED_COMMANDS } from '../../../hank/tools/BashTool/prompt'
import { DESCRIPTION, PROMPT } from './prompt'

const STORE_FILE = join(ECHO_BASE_DIR, 'shortcuts.json')

type Shortcut = { steps: string[]; createdAt: number }
type Store = Record<string, Shortcut>

function loadStore(): Store {
  if (!existsSync(STORE_FILE)) return {}
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8')) as Store
  } catch {
    return {}
  }
}

function saveStore(store: Store): void {
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

function bannedIn(command: string): string | undefined {
  return BANNED_COMMANDS.find((cmd) =>
    command.split(/[;&|]+/).some((part) => part.trim().split(/\s+/)[0] === cmd)
  )
}

const inputSchema = z.object({
  action: z.enum(['define', 'run', 'list', 'delete']).describe('What to do with shortcuts'),
  name: z.string().optional().describe('Shortcut name (required for define, run, delete)'),
  steps: z
    .array(z.string())
    .optional()
    .describe('For action=define: ordered shell commands the shortcut runs')
})

export const ShortcutTool = tool({
  title: 'Shortcut',
  description: DESCRIPTION + '\n\n' + PROMPT,
  inputSchema,
  execute: async ({ action, name, steps }, { experimental_context }) => {
    const store = loadStore()
    const key = name?.trim().toLowerCase()

    switch (action) {
      case 'list': {
        const shortcuts = Object.entries(store).map(([n, s]) => ({ name: n, steps: s.steps }))
        return { success: true, shortcuts }
      }
      case 'define': {
        if (!key) return { success: false, error: 'define needs a name.' }
        if (!steps || steps.length === 0) return { success: false, error: 'define needs at least one step.' }
        for (const step of steps) {
          const banned = bannedIn(step)
          if (banned) return { success: false, error: `Step uses banned command "${banned}": ${step}` }
          const protectedHit = scanCommandForProtected(step, process.cwd())
          if (protectedHit) return { success: false, error: protectedHit }
        }
        store[key] = { steps, createdAt: Date.now() }
        saveStore(store)
        return { success: true, defined: key, steps }
      }
      case 'delete': {
        if (!key) return { success: false, error: 'delete needs a name.' }
        if (!store[key]) return { success: false, error: `No shortcut named "${key}".` }
        delete store[key]
        saveStore(store)
        return { success: true, deleted: key }
      }
      case 'run': {
        if (!key) return { success: false, error: 'run needs a name.' }
        const shortcut = store[key]
        if (!shortcut) {
          return { success: false, error: `No shortcut named "${key}". Define it first.`, known: Object.keys(store) }
        }
        const shellKey = typeof experimental_context === 'string' ? experimental_context : 'default'
        const shell = PersistentShell.getInstance(shellKey)
        const launched: string[] = []
        const failed: { step: string; error: string }[] = []
        for (const step of shortcut.steps) {
          const banned = bannedIn(step)
          if (banned) {
            failed.push({ step, error: `banned command "${banned}"` })
            continue
          }
          const protectedHit = scanCommandForProtected(step, shell.pwd())
          if (protectedHit) {
            failed.push({ step, error: protectedHit })
            continue
          }
          try {
            const b64 = Buffer.from(step, 'utf-8').toString('base64')
            await shell.exec(
              `echo ${b64} | base64 -d | nohup setsid bash >/dev/null 2>&1 &`,
              undefined,
              8000
            )
            launched.push(step)
          } catch (err) {
            failed.push({ step, error: String(err) })
          }
        }
        return { success: failed.length === 0, name: key, launched, failed }
      }
    }
  }
})
