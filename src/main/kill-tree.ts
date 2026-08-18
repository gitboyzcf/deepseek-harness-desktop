import { spawn } from 'node:child_process'

/**
 * 跨平台杀掉整个进程树。
 * Windows: taskkill /T 杀整棵树; POSIX: 依赖 spawn 时的 detached:true, 对进程组发信号。
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      })
    } catch {
      /* 进程可能已退出 */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 进程可能已退出 */
      }
    }
  }
}
