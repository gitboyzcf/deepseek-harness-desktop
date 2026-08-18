import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import { DshManager, type DshStatus } from './dsh-manager'
import { resolveRuntime } from './runtime'
import { checkAndUpdateDsh } from './dsh-updater'

let mainWindow: BrowserWindow | null = null
let manager: DshManager | null = null
let dshLoaded = false

// 单实例: 重复打开时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

function sendStatus(status: DshStatus): void {
  mainWindow?.webContents.send('dsh:status', status)
}

function sendLog(line: string): void {
  mainWindow?.webContents.send('dsh:log', line)
}

function showLoadingPage(): void {
  dshLoaded = false
  if (!mainWindow) return
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a1120',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => (mainWindow = null))

  // dsh 界面里的外链一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  showLoadingPage()
}

function bootDsh(): void {
  const runtime = resolveRuntime()
  if (!runtime) {
    sendStatus({
      state: 'error',
      message: is.dev
        ? '运行时缺失: 请先执行 pnpm prepare:runtime'
        : '运行时缺失或已损坏, 请重新安装客户端'
    })
    return
  }

  sendLog(`运行时: ${runtime.source === 'live' ? '用户目录副本' : '安装包内置'} (dsh v${runtime.version})`)

  manager = new DshManager(runtime)
  manager.on('log', sendLog)
  manager.on('status', (status: DshStatus) => {
    sendStatus(status)
    if (status.state === 'running' && status.url && mainWindow) {
      dshLoaded = true
      mainWindow.loadURL(status.url)
      backgroundUpdate(runtime.version)
    }
    if (status.state === 'error' && dshLoaded) {
      // 服务中断: 切回加载页展示错误与重试入口
      showLoadingPage()
      // loadFile 是异步的, 等页面加载完再补发一次状态
      mainWindow?.webContents.once('did-finish-load', () => sendStatus(status))
    }
  })
  manager.start()
}

/** 服务就绪后在后台静默升级 dsh 内核, 下次启动生效 */
function backgroundUpdate(currentVersion: string): void {
  const runtime = resolveRuntime()
  if (!runtime) return
  sendLog(`后台检查 dsh 更新 (当前 v${currentVersion})…`)
  checkAndUpdateDsh(runtime, sendLog)
    .then((result) => {
      sendLog(`[更新] ${result.message}`)
      if (result.updated) sendStatus({ state: 'running', message: result.message })
    })
    .catch((err: Error) => sendLog(`[更新] 检查失败: ${err.message}`))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('io.github.gitboyzcf.deepseek-harness-desktop')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('dsh:retry', () => {
    if (manager) manager.restart()
    else bootDsh()
  })

  createWindow()
  bootDsh()

  // 客户端自身的更新(仅安装包环境; 发布后由 GitHub Releases 提供)
  if (app.isPackaged) {
    try {
      autoUpdater.checkForUpdatesAndNotify()
    } catch (err) {
      sendLog(`[客户端更新] 检查失败: ${(err as Error).message}`)
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      if (!manager?.getUrl()) bootDsh()
      else if (manager.getUrl()) mainWindow?.loadURL(manager.getUrl()!)
    }
  })
})

// 退出前务必杀掉 dsh 子进程树, 防止端口残留
app.on('before-quit', () => {
  manager?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
