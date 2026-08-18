import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface DshStatus {
  state: 'starting' | 'running' | 'error' | 'stopped'
  message: string
  url?: string
}

const dshApi = {
  onStatus: (callback: (status: DshStatus) => void): void => {
    ipcRenderer.on('dsh:status', (_event, status: DshStatus) => callback(status))
  },
  onLog: (callback: (line: string) => void): void => {
    ipcRenderer.on('dsh:log', (_event, line: string) => callback(line))
  },
  retry: (): void => {
    ipcRenderer.send('dsh:retry')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('dsh', dshApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error 非隔离模式直接挂到 window
  window.electron = electronAPI
  // @ts-expect-error 非隔离模式直接挂到 window
  window.dsh = dshApi
}
