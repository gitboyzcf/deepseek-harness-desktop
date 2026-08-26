import { app, shell, BrowserWindow, ipcMain, dialog, Tray, Menu } from 'electron'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import { DshManager, type DshStatus } from './dsh-manager'
import { resolveRuntime } from './runtime'
import { checkAndUpdateDsh } from './dsh-updater'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let manager: DshManager | null = null
let dshLoaded = false
/** 托盘"退出"菜单置位, 用于区分"关窗口(最小化到托盘)"与"真正退出" */
let isQuitting = false
/** 开机自启时以 --hidden 拉起: 只在后台预热 dsh 服务, 不弹窗 */
const startHidden = process.argv.includes('--hidden')

// 单实例: 重复打开时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
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
  // 关窗口 = 最小化到托盘, dsh 服务保持运行; 真正退出走托盘"退出"菜单
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  // dsh 界面里的外链一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 服务已在运行(托盘常驻期间)时直接进界面, 不再经过加载页
  const readyUrl = manager?.getUrl()
  if (readyUrl) {
    dshLoaded = true
    mainWindow.loadURL(readyUrl)
  } else {
    showLoadingPage()
  }
}

/** 显示(或重建)主窗口并聚焦; 服务已就绪时秒开界面 */
function showMainWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

const AUTORUN_VALUE = 'DeepSeekHarness'
const AUTORUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

/**
 * 直写 HKCU Run 键(无需管理员权限)。
 * 不用 app.setLoginItemSettings: 实测 Electron 39 打包应用上该 API 静默失败(注册表无写入)。
 */
function setAutoStart(enabled: boolean): void {
  try {
    if (process.platform === 'win32') {
      if (enabled) {
        spawnSync(
          'reg',
          ['add', AUTORUN_KEY, '/v', AUTORUN_VALUE, '/t', 'REG_SZ', '/d', `"${process.execPath}" --hidden`, '/f'],
          { windowsHide: true }
        )
      } else {
        spawnSync('reg', ['delete', AUTORUN_KEY, '/v', AUTORUN_VALUE, '/f'], { windowsHide: true })
      }
    } else {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
    }
  } catch {
    /* 注册表不可写时不影响主流程 */
  }
}

function getAutoStart(): boolean {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('reg', ['query', AUTORUN_KEY, '/v', AUTORUN_VALUE], { windowsHide: true })
      return r.status === 0
    }
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

/** 系统托盘: 打开主窗口 / 开机自启开关 / 退出 */
function setupTray(): void {
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.on('click', () => showMainWindow())
  rebuildTrayMenu()
}

function rebuildTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 DeepSeek Harness', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: app.isPackaged ? getAutoStart() : true,
        enabled: app.isPackaged,
        click: (item) => {
          setAutoStart(item.checked)
          rebuildTrayMenu()
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
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

  // 首次启动弹窗让用户选择是否开机自启(默认"开启"); 之后可随时在托盘右键菜单里开关(点一下开/再点一下关)。
  // 标记文件区分"从未询问"和"已询问过", 避免每次启动重复弹窗
  if (!startHidden) {
    createWindow()
    // 窗口创建时 show:false, 父窗口不可见会导致模态弹窗不显示 —— 等窗口真正显示后再弹
    mainWindow?.once('show', () => void promptAutoStart())
  }
  setupTray()
  bootDsh()
  setupAutoUpdater()

  app.on('activate', () => showMainWindow())
})

/** 首次启动时让用户自行选择是否开机自启(默认开启); 选择结果之后以托盘菜单开关为准 */
async function promptAutoStart(): Promise<void> {
  if (!app.isPackaged) return
  const marker = join(app.getPath('userData'), 'login-item-initialized')
  if (existsSync(marker)) return
  const options = {
    type: 'question' as const,
    title: '开机自动启动',
    message: '是否允许 DeepSeek Harness 开机自动启动？',
    detail: '开启后仅在后台预热服务(不弹窗), 之后双击图标即可秒开;\n随时可以右键托盘图标, 在菜单里更改此设置。',
    buttons: ['开启 (推荐)', '不开启'],
    defaultId: 0,
    cancelId: 0
  }
  const { response } = mainWindow
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options)
  setAutoStart(response === 0)
  writeFileSync(marker, '')
  rebuildTrayMenu()
}

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
      // isSilent=true 静默安装(否则 NSIS 安装器界面可能被用户关掉导致更新没装上);
      // isForceRunAfter=true 装完自动重新拉起(默认 false, 用户以为没反应)
      autoUpdater.quitAndInstall(true, true)
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
  isQuitting = true
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
