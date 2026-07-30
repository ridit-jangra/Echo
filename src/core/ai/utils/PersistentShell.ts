/* eslint-disable @typescript-eslint/no-require-imports */
/* eslint-disable no-empty */
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import * as fs from 'fs'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { spawn, type ChildProcess } from 'child_process'
import { isAbsolute, resolve, join } from 'path'
import * as os from 'os'
import { shellStream } from './shellStream'

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
}

type QueuedCommand = {
  command: string
  abortSignal?: AbortSignal
  timeout?: number
  onChunk?: (chunk: string) => void
  resolve: (result: ExecResult) => void
  reject: (error: Error) => void
}

const TEMPFILE_PREFIX = os.tmpdir() + '/milo-'
const DEFAULT_TIMEOUT = 30 * 60 * 1000
const SIGTERM_CODE = 143
const FILE_SUFFIXES = {
  STATUS: '-status',
  STDOUT: '-stdout',
  STDERR: '-stderr',
  CWD: '-cwd'
}
const SHELL_CONFIGS: Record<string, string> = {
  '/bin/bash': '.bashrc',
  '/bin/zsh': '.zshrc'
}

export class PersistentShell {
  private commandQueue: QueuedCommand[] = []
  private isExecuting = false
  private shell: ChildProcess
  private isAlive = true
  private commandInterrupted = false
  private sessionAborted = false
  private statusFile: string
  private stdoutFile: string
  private stderrFile: string
  private cwdFile: string
  private cwd: string
  private binShell: string
  private activeChild: ChildProcess | null = null

  constructor(cwd: string) {
    this.binShell =
      process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash')

    this.shell = spawn(
      process.platform === 'win32' ? 'cmd.exe' : this.binShell,
      process.platform === 'win32' ? [] : ['-l'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: { ...process.env, GIT_EDITOR: 'true' }
      }
    )

    this.cwd = cwd

    this.shell.on('exit', (code, signal) => {
      if (code) console.error(`Shell exited with code ${code} signal ${signal}`)
      for (const file of [this.statusFile, this.stdoutFile, this.stderrFile, this.cwdFile]) {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      }
      this.isAlive = false
    })

    const id = Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0')
    this.statusFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STATUS
    this.stdoutFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STDOUT
    this.stderrFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.STDERR
    this.cwdFile = TEMPFILE_PREFIX + id + FILE_SUFFIXES.CWD

    for (const file of [this.statusFile, this.stdoutFile, this.stderrFile]) {
      fs.writeFileSync(file, '')
    }
    fs.writeFileSync(this.cwdFile, cwd)

    if (process.platform !== 'win32') {
      const configFile = SHELL_CONFIGS[this.binShell]
      if (configFile) {
        const configFilePath = join(homedir(), configFile)
        if (existsSync(configFilePath)) {
          this.sendToShell(`source ${configFilePath}`)
        }
      }
    }
  }

  private static instances = new Map<string, PersistentShell>()

  static getInstance(key: string): PersistentShell {
    const existing = PersistentShell.instances.get(key)
    if (existing && existing.isAlive) return existing
    const shell = new PersistentShell(process.cwd())
    PersistentShell.instances.set(key, shell)
    return shell
  }

  static restart(key: string) {
    const existing = PersistentShell.instances.get(key)
    if (existing) {
      existing.close()
      PersistentShell.instances.delete(key)
    }
  }

  resetAbort() {
    this.sessionAborted = false
    this.commandInterrupted = false
  }

  killChildren() {
    if (process.platform === 'win32') {
      if (this.activeChild?.pid) {
        spawn('taskkill', ['/F', '/T', '/PID', String(this.activeChild.pid)], {
          stdio: 'ignore'
        })
      }
    } else {
      const parentPid = this.shell.pid
      if (!parentPid) return
      try {
        const { execSync } = require('child_process')
        const childPids = execSync(`pgrep -P ${parentPid}`)
          .toString()
          .trim()
          .split('\n')
          .filter(Boolean)
        childPids.forEach((pid: string) => {
          try {
            process.kill(Number(pid), 'SIGTERM')
          } catch {}
        })
      } catch {}
    }
    this.commandInterrupted = true
    this.sessionAborted = true
    shellStream.emit('done')
  }

  private async processQueue() {
    if (this.isExecuting || this.commandQueue.length === 0) return
    this.isExecuting = true
    const { command, abortSignal, timeout, onChunk, resolve, reject } = this.commandQueue.shift()!
    const killChildren = () => this.killChildren()
    if (abortSignal) abortSignal.addEventListener('abort', killChildren)
    try {
      resolve(await this.exec_(command, timeout, onChunk, abortSignal))
    } catch (error) {
      reject(error as Error)
    } finally {
      this.isExecuting = false
      if (abortSignal) abortSignal.removeEventListener('abort', killChildren)
      this.processQueue()
    }
  }

  async exec(
    command: string,
    abortSignal?: AbortSignal,
    timeout?: number,
    onChunk?: (chunk: string) => void
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.commandQueue.push({
        command,
        abortSignal,
        timeout,
        onChunk,
        resolve,
        reject
      })
      this.processQueue()
    })
  }

  async execute(
    command: string,
    timeout?: number,
    onChunk?: (chunk: string) => void
  ): Promise<string> {
    const result = await this.exec(command, undefined, timeout, onChunk)
    const combined = [result.stdout, result.stderr].filter(Boolean).join('\n')
    return combined
  }

  private async exec_(
    command: string,
    timeout?: number,
    onChunk?: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<ExecResult> {
    if (this.sessionAborted) {
      return {
        stdout: '',
        stderr: 'Interrupted',
        code: SIGTERM_CODE,
        interrupted: true
      }
    }

    const commandTimeout = timeout || DEFAULT_TIMEOUT
    this.commandInterrupted = false

    if (process.platform === 'win32') {
      return this.execWindows(command, commandTimeout, onChunk, abortSignal)
    }

    return new Promise<ExecResult>((resolve) => {
      fs.writeFileSync(this.stdoutFile, '')
      fs.writeFileSync(this.stderrFile, '')
      fs.writeFileSync(this.statusFile, '')

      const commandParts = [
        `eval ${JSON.stringify(command)} < /dev/null > ${this.stdoutFile} 2> ${this.stderrFile}`,
        `EXEC_EXIT_CODE=$?`,
        `pwd > ${this.cwdFile}`,
        `echo $EXEC_EXIT_CODE > ${this.statusFile}`
      ]

      this.sendToShell(commandParts.join('\n'))

      let tailOffset = 0
      const tailInterval = setInterval(() => {
        if (!onChunk) return
        try {
          const stat = fs.statSync(this.stdoutFile)
          if (stat.size > tailOffset) {
            const buf = Buffer.alloc(stat.size - tailOffset)
            const fd = fs.openSync(this.stdoutFile, 'r')
            fs.readSync(fd, buf, 0, buf.length, tailOffset)
            fs.closeSync(fd)
            tailOffset = stat.size
            onChunk(buf.toString())
          }
        } catch {}
      }, 50)

      const start = Date.now()
      const checkCompletion = setInterval(() => {
        try {
          const statusSize = fs.existsSync(this.statusFile) ? fs.statSync(this.statusFile).size : 0

          if (statusSize > 0 || Date.now() - start > commandTimeout || this.commandInterrupted) {
            clearInterval(checkCompletion)
            clearInterval(tailInterval)

            if (this.commandInterrupted) {
              shellStream.emit('done')
            }

            const stdout = fs.existsSync(this.stdoutFile)
              ? fs.readFileSync(this.stdoutFile, 'utf8')
              : ''
            let stderr = fs.existsSync(this.stderrFile)
              ? fs.readFileSync(this.stderrFile, 'utf8')
              : ''
            let code: number
            if (statusSize) {
              code = Number(fs.readFileSync(this.statusFile, 'utf8'))
            } else {
              this.killChildren()
              code = SIGTERM_CODE
              stderr += (stderr ? '\n' : '') + 'Command timed out'
            }
            resolve({
              stdout,
              stderr,
              code,
              interrupted: this.commandInterrupted
            })
          }
        } catch {}
      }, 10)
    })
  }

  private async execWindows(
    command: string,
    timeout: number,
    onChunk?: (chunk: string) => void,
    abortSignal?: AbortSignal
  ): Promise<ExecResult> {
    if (this.sessionAborted) {
      return {
        stdout: '',
        stderr: 'Interrupted',
        code: SIGTERM_CODE,
        interrupted: true
      }
    }

    return new Promise((resolve) => {
      let stdout = ''
      let stderr = ''
      let resolved = false

      const child = spawn('powershell.exe', ['-NoProfile', '-Command', command], {
        cwd: this.cwd,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      })

      this.activeChild = child

      const doKill = (reason: string) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        if (child.pid) {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
            stdio: 'ignore'
          })
        }
        this.activeChild = null
        shellStream.emit('done')
        resolve({
          stdout,
          stderr: stderr + `\n${reason}`,
          code: SIGTERM_CODE,
          interrupted: true
        })
      }

      abortSignal?.addEventListener('abort', () => doKill('Interrupted'))

      child.stdout?.on('data', (d) => {
        const chunk = d.toString()
        stdout += chunk
        onChunk?.(chunk)
      })

      child.stderr?.on('data', (d) => {
        const chunk = d.toString()
        stderr += chunk
        onChunk?.(chunk)
      })

      const timer = setTimeout(() => doKill('Command timed out'), timeout)

      child.on('close', (code) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        this.activeChild = null
        try {
          const newCwd = require('child_process')
            .execSync('cd', { cwd: this.cwd, encoding: 'utf8' })
            .trim()
          if (newCwd) this.cwd = newCwd
        } catch {}
        resolve({ stdout, stderr, code: code ?? 0, interrupted: false })
      })

      child.on('error', (err) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        this.activeChild = null
        resolve({ stdout, stderr: String(err), code: 1, interrupted: false })
      })
    })
  }

  private sendToShell(command: string) {
    this.shell.stdin!.write(command + '\n')
  }

  pwd(): string {
    try {
      const newCwd = fs.readFileSync(this.cwdFile, 'utf8').trim()
      if (newCwd) this.cwd = newCwd
    } catch {}
    return this.cwd
  }

  async setCwd(cwd: string) {
    const resolved = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)
    if (!existsSync(resolved)) throw new Error(`Path "${resolved}" does not exist`)
    await this.exec(`cd ${resolved}`)
  }

  close() {
    this.shell.stdin!.end()
    this.shell.kill()
  }
}
