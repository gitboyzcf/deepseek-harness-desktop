import { ElectronAPI } from '@electron-toolkit/preload'

export interface DshStatus {
  state: 'starting' | 'running' | 'error' | 'stopped'
  message: string
  url?: string
}

export interface DshApi {
  onStatus: (callback: (status: DshStatus) => void) => void
  onLog: (callback: (line: string) => void) => void
  retry: () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    dsh: DshApi
  }
}
