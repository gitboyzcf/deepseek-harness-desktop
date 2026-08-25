const statusEl = document.getElementById('status')!
const logEl = document.getElementById('log')!
const retryBtn = document.getElementById('retry')!
const barEl = document.getElementById('bar')!
const hintEl = document.getElementById('hint')!

const MAX_LOG_LINES = 200
/** 启动超过该时长仍未就绪时, 展示"冷启动说明"避免用户误以为卡死 */
const SLOW_HINT_DELAY_MS = 8_000
const SLOW_HINT_TEXT =
  '重启电脑后首次启动需要重新读取运行时文件并接受系统安全扫描, 可能需要 20~40 秒; 之后每次打开通常只需几秒。'

let logLines: string[] = []
let slowHintTimer: number | undefined

interface DshStatus {
  state: 'starting' | 'running' | 'error' | 'stopped'
  message: string
  url?: string
}

function clearSlowHint(): void {
  if (slowHintTimer !== undefined) {
    clearTimeout(slowHintTimer)
    slowHintTimer = undefined
  }
  hintEl.classList.add('hidden')
}

function setStatus(status: DshStatus): void {
  statusEl.textContent = status.message
  const isError = status.state === 'error'
  statusEl.classList.toggle('error', isError)
  barEl.classList.toggle('error', isError)
  retryBtn.classList.toggle('hidden', !isError)

  clearSlowHint()
  if (status.state === 'starting') {
    slowHintTimer = window.setTimeout(() => {
      hintEl.textContent = SLOW_HINT_TEXT
      hintEl.classList.remove('hidden')
    }, SLOW_HINT_DELAY_MS)
  }
}

function appendLog(line: string): void {
  logLines.push(line)
  if (logLines.length > MAX_LOG_LINES) logLines = logLines.slice(-MAX_LOG_LINES)
  logEl.textContent = logLines.join('\n')
  logEl.scrollTop = logEl.scrollHeight
}

window.dsh.onStatus(setStatus)
window.dsh.onLog(appendLog)

retryBtn.addEventListener('click', () => {
  retryBtn.classList.add('hidden')
  barEl.classList.remove('error')
  statusEl.classList.remove('error')
  statusEl.textContent = '正在重启服务…'
  window.dsh.retry()
})
