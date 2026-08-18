const statusEl = document.getElementById('status')!
const logEl = document.getElementById('log')!
const retryBtn = document.getElementById('retry')!
const ringEl = document.getElementById('ring')!

const MAX_LOG_LINES = 200
let logLines: string[] = []

interface DshStatus {
  state: 'starting' | 'running' | 'error' | 'stopped'
  message: string
  url?: string
}

function setStatus(status: DshStatus): void {
  statusEl.textContent = status.message
  const isError = status.state === 'error'
  statusEl.classList.toggle('error', isError)
  ringEl.classList.toggle('error', isError)
  retryBtn.classList.toggle('hidden', !isError)
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
  ringEl.classList.remove('error')
  statusEl.classList.remove('error')
  statusEl.textContent = '正在重启服务…'
  window.dsh.retry()
})
