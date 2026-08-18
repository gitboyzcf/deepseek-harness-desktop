import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
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
  console.log('[dsh:status]', status.state, status.message, status.url ?? '')
  mainWindow?.webContents.send('dsh:status', status)
}

function sendLog(line: string): void {
  console.log('[dsh:log]', line)
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
  setupAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      if (!manager?.getUrl()) bootDsh()
      else if (manager.getUrl()) mainWindow?.loadURL(manager.getUrl()!)
    }
  })
})

/**
 * 客户端自身更新: 每次启动检查 → 发现新版静默下载 → 下载完成弹窗询问是否立即重启
 * (仅安装包环境; 更新源为 GitHub Releases)
 */
function setupAutoUpdater(): void {
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true // 发现新版即后台静默下载
  autoUpdater.autoInstallOnAppQuit = true // 用户选"稍后"时, 退出自动安装

  autoUpdater.on('update-available', (info) => {
    sendLog(`[客户端更新] 发现新版本 v${info.version}, 后台静默下载中…`)
  })
  autoUpdater.on('update-downloaded', async (info) => {
    sendLog(`[客户端更新] v${info.version} 下载完成`)
    const win = mainWindow
    const options = {
      type: 'info' as const,
      title: '更新就绪',
      message: `新版本 v${info.version} 已就绪`,
      detail: '立即重启完成更新; 选择"稍后"则会在下次启动时自动生效。',
      buttons: ['立即重启更新', '稍后'],
      defaultId: 0,
      cancelId: 1
    }
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    if (response === 0) {
      manager?.stop()
      autoUpdater.quitAndInstall()
    }
  })
  autoUpdater.on('error', (err) => {
    // 尚无 Release / 网络不可达均属正常, 记日志即可
    sendLog(`[客户端更新] ${err.message}`)
  })

  autoUpdater.checkForUpdates().catch(() => {
    /* 错误已在 error 事件里记录 */
  })
}

// 退出前务必杀掉 dsh 子进程树, 防止端口/进程残留
app.on('before-quit', () => {
  manager?.stop()
})
// before-quit 之外的兜底(异常退出路径)
process.on('exit', () => {
  manager?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
