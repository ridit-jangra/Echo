import { join } from 'path'
import { homedir } from 'os'
import { cwd } from 'process'
import { mkdirSync, existsSync, readdirSync, statSync, cpSync } from 'fs'

export const ECHO_BASE_DIR = join(homedir(), '.echo')
export const MEMORY_DIR = join(ECHO_BASE_DIR, 'memory')
export const BACKUP_ROOT = join(homedir(), '.local', 'share', 'echo-backups')

export function storeHasContent(dir: string): boolean {
  try {
    if (!existsSync(dir)) return false
    const mem = join(dir, 'memory')
    const hasMemory =
      existsSync(mem) && readdirSync(mem).some((f) => f.endsWith('.md') || f.endsWith('.mdc'))
    const dexterMem = join(dir, 'dexter-memory')
    const hasDexterMemory =
      existsSync(dexterMem) && readdirSync(dexterMem).some((f) => f.endsWith('.md'))
    const user = join(dir, 'user.md')
    const hasUser = existsSync(user) && statSync(user).size > 0
    const sessions = join(dir, 'sessions')
    const hasSessions = existsSync(sessions) && readdirSync(sessions).length > 0
    return hasMemory || hasDexterMemory || hasUser || hasSessions
  } catch {
    return false
  }
}

function newestBackupWithContent(): string | null {
  try {
    if (!existsSync(BACKUP_ROOT)) return null
    const dirs = readdirSync(BACKUP_ROOT)
      .filter((n) => n.startsWith('echo-'))
      .map((n) => join(BACKUP_ROOT, n))
      .filter((p) => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
      .reverse()
    for (const dir of dirs) {
      if (storeHasContent(dir)) return dir
    }
    return null
  } catch {
    return null
  }
}

function guardEchoStore(): void {
  if (process.env.ECHO_NO_RESTORE === '1') return
  try {
    if (storeHasContent(ECHO_BASE_DIR)) return
    const backup = newestBackupWithContent()
    if (!backup) return
    mkdirSync(ECHO_BASE_DIR, { recursive: true })
    cpSync(backup, ECHO_BASE_DIR, { recursive: true, force: true })
    console.warn(
      `[miles] ⚠️  ~/.echo was empty or missing (memory/user/sessions all gone). ` +
        `Auto-restored from backup: ${backup}. ` +
        `If you wiped it on purpose, relaunch with ECHO_NO_RESTORE=1.`
    )
  } catch (err) {
    console.error('[miles] store guard failed:', err)
  }
}

guardEchoStore()

mkdirSync(ECHO_BASE_DIR, { recursive: true })
mkdirSync(MEMORY_DIR, { recursive: true })

export const PROJECT_MEMORY_FILE = join(cwd(), 'MILO.md')
export const SESSIONS_DIR = join(ECHO_BASE_DIR, 'sessions')
export const USER_FILE = join(ECHO_BASE_DIR, 'user.md')
export const EXECUTION_STATE_FILE = join(ECHO_BASE_DIR, 'execution-state.json')
export const PORT_FILE = join(ECHO_BASE_DIR, 'milo.port')
export const CONFIG_FILE = join(ECHO_BASE_DIR, 'config.json')
export const MCP_CONFIG_FILE = join(ECHO_BASE_DIR, 'mcp.json')
export const BRIEFING_STATE_FILE = join(ECHO_BASE_DIR, 'briefing-state.json')
export const SUBSCRIPTIONS_FILE = join(ECHO_BASE_DIR, 'subscriptions.json')
export const BOOTSTRAP_FILE = join(ECHO_BASE_DIR, 'bootstrap.txt')
export const SCREEN_LOG_DIR = join(ECHO_BASE_DIR, 'screen-log')
export const SCREENSHOTS_DIR = join(ECHO_BASE_DIR, 'screenshots')
export const HUMAN_MEMORY_FILE = join(MEMORY_DIR, 'human-memory.md')
