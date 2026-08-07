import { ipcMain } from 'electron'
import { FILLER_REFRESH } from '../../shared/channels'
import { refreshFillerPool, type FillerAgent } from '../../core/events/fillers'

ipcMain.on(FILLER_REFRESH, (_event, agent: FillerAgent, context: string) => {
  refreshFillerPool(agent, context ?? '')
})
