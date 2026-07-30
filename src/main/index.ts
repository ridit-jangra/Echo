import { config } from 'dotenv'
import { applyStoredSettings } from './ipc/settings'
config()
applyStoredSettings()

import './ipc/stt'
import './ipc/tts'
import { startServer, stopServer } from './ipc/server'
import { ensureBrowserLauncher } from './ipc/browser'
import './ipc/ai'
import './ipc/mcp'
import './ipc/oauth'
import './ipc/briefing'
import { mcpManager } from '../core/mcp/manager'
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'

app.commandLine.appendSwitch('disable-v8-sandbox')
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  WAKE_FOCUS_WINDOW,
  WAKE_TRIGGER,
  DND_ENTERED,
  EVENT_ALERT,
  SPEAK_SAY
} from '../shared/channels'
import { startWakeListener } from './ipc/wake'
import { isDnd, setDndEnterNotifier } from '../core/events/dnd'
import { startSlackPoller } from '../core/events/slack-poller'
import { startSlackStyleCollector } from '../core/events/slack-style-collector'
import { startSubagentMonitor } from '../core/events/subagent-monitor'
import { startJoker } from '../core/ai/agents/custom-agents/joker/agent'
import { startArgus } from '../core/ai/agents/custom-agents/argus/agent'
import { startIris } from '../core/ai/agents/custom-agents/iris/agent'
import { startSybil } from '../core/ai/agents/custom-agents/sybil/agent'
import {
  startCerberus,
  triageAlert,
  collectSuppressed
} from '../core/ai/agents/custom-agents/cerberus/agent'
import { startJanus } from '../core/ai/agents/custom-agents/janus/agent'
import { startScheduler } from '../core/events/scheduler'
import { narrateAlert } from '../core/events/narrate'
import { setSpeechEmitter } from '../core/events/speech'
import { announce, markActivity, startAnnouncementFlusher } from '../core/events/announcements'
import { startBackupTimer, backupEchoStore } from '../core/ai/utils/backup'

let stopBackupTimer: (() => void) | null = null
let stopJoker: (() => void) | null = null
let stopArgus: (() => void) | null = null
let stopIris: (() => void) | null = null
let stopSybil: (() => void) | null = null
let stopCerberus: (() => void) | null = null
let stopJanus: (() => void) | null = null
let stopScheduler: (() => void) | null = null
let stopAnnouncements: (() => void) | null = null

function createWindow(): void {
  console.log('[debug] createWindow called, is.dev=', is.dev, 'ELECTRON_RENDERER_URL=', process.env['ELECTRON_RENDERER_URL'])
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  mainWindow.webContents.on('did-fail-load', (_, code, desc) => {
    console.error('[debug] renderer failed to load:', code, desc)
  })
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    console.error('[debug] renderer process gone:', details.reason, details.exitCode)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[debug] renderer finished loading')
  })

  function focusMainWindow(): void {
    const win = mainWindow
    if (!win || win.isDestroyed()) return

    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()

    win.setAlwaysOnTop(true)
    win.show()
    win.focus()
    win.setAlwaysOnTop(false)

    if (process.platform === 'darwin') app.focus({ steal: true })
  }

  ipcMain.on(WAKE_FOCUS_WINDOW, () => {
    markActivity()
    focusMainWindow()
  })

  // setGestureHandler(() => {
  //   if (isDnd()) return
  //   markActivity()
  //   focusMainWindow()
  // })

  setDndEnterNotifier(() => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(DND_ENTERED)
  })

  mainWindow.on('ready-to-show', () => {
    console.log('[debug] ready-to-show firing, showing window')
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    console.log('[debug] loading dev URL:', process.env['ELECTRON_RENDERER_URL'])
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    const filePath = join(__dirname, '../renderer/index.html')
    console.log('[debug] loading file:', filePath)
    mainWindow.loadFile(filePath)
  }

  setSpeechEmitter((text, listen) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(SPEAK_SAY, text, listen)
  })

  const stopPoller = startSlackPoller(async (alert, subs) => {
    if (mainWindow.isDestroyed()) return
    mainWindow.webContents.send(EVENT_ALERT, alert)
    const verdict = triageAlert(alert, subs)
    if (verdict.surface) announce(await narrateAlert(alert))
    else collectSuppressed(alert)
  })
  const stopStyleCollector = startSlackStyleCollector()
  const stopSubagentMonitor = startSubagentMonitor()
  const stopWakeListener = startWakeListener(() => {
    if (mainWindow.isDestroyed() || isDnd()) return
    markActivity()
    focusMainWindow()
    mainWindow.webContents.send(WAKE_TRIGGER)
  })
  mainWindow.on('closed', () => {
    stopPoller()
    stopStyleCollector()
    stopSubagentMonitor()
    stopWakeListener()
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  ensureBrowserLauncher()
  stopBackupTimer = startBackupTimer()
  stopJoker = startJoker()
  stopArgus = startArgus()
  stopIris = startIris()
  stopSybil = startSybil()
  stopCerberus = startCerberus()
  stopJanus = startJanus()
  stopScheduler = startScheduler()
  stopAnnouncements = startAnnouncementFlusher()
  startServer().catch((err) => console.error('[server] start failed:', err))

  mcpManager.init().catch((err) => console.error('[MCP] init failed:', err))

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (stopBackupTimer) stopBackupTimer()
  if (stopJoker) stopJoker()
  if (stopArgus) stopArgus()
  if (stopIris) stopIris()
  if (stopSybil) stopSybil()
  if (stopCerberus) stopCerberus()
  if (stopJanus) stopJanus()
  if (stopScheduler) stopScheduler()
  if (stopAnnouncements) stopAnnouncements()
  backupEchoStore()
  stopServer()
  mcpManager.shutdown().catch((err) => console.error('[MCP] shutdown failed:', err))
})
