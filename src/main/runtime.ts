import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface RuntimeInfo {
  /** node 可执行文件路径(不存在时回退为 PATH 中的 node) */
  nodeExe: string
  /** npm-cli.js 路径(用于 dsh 升级;不存在则为空串) */
  npmCli: string
  /** dsh 安装目录(包含 node_modules/@deepseek-ai/dsh) */
  dshDir: string
  /** dsh CLI 入口 */
  dshBin: string
  /** 当前 dsh 版本 */
  version: string
  /** live = 用户目录可写副本; bundled = 安装包内置只读副本 */
  source: 'live' | 'bundled'
}

function nodeBinName(): string {
  return process.platform === 'win32' ? 'node.exe' : 'node'
}

/** 安装包内置运行时目录(只读) */
export function bundledRuntimeRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'runtime')
    : path.join(app.getAppPath(), 'resources', 'runtime')
}

/** 用户目录下的可写运行时副本(用于 dsh 增量升级) */
export function liveRuntimeRoot(): string {
  return path.join(app.getPath('userData'), 'runtime')
}

export function inspectRuntime(root: string): RuntimeInfo | null {
  const dshPkgPath = path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!fs.existsSync(dshPkgPath)) return null

  let version = '0.0.0'
  try {
    version = JSON.parse(fs.readFileSync(dshPkgPath, 'utf8')).version ?? version
  } catch {
    /* 忽略, 按未知版本处理 */
  }

  const nodeExe = path.join(root, 'node', nodeBinName())
  const npmCli = path.join(root, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')

  return {
    nodeExe: fs.existsSync(nodeExe) ? nodeExe : nodeBinName(),
    npmCli: fs.existsSync(npmCli) ? npmCli : '',
    dshDir: path.join(root, 'dsh'),
    dshBin: path.join(root, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    version,
    source: 'bundled'
  }
}

/** 优先使用 live(已升级过)副本, 否则回退到安装包内置副本 */
export function resolveRuntime(): RuntimeInfo | null {
  const live = inspectRuntime(liveRuntimeRoot())
  if (live) {
    live.source = 'live'
    return live
  }
  const bundled = inspectRuntime(bundledRuntimeRoot())
  if (bundled) {
    bundled.source = 'bundled'
    return bundled
  }
  return null
}

/** 将内置运行时完整拷贝到用户目录(升级前置步骤) */
export function materializeLiveRuntime(): RuntimeInfo {
  const live = liveRuntimeRoot()
  const existing = inspectRuntime(live)
  if (existing) {
    existing.source = 'live'
    return existing
  }
  const bundled = bundledRuntimeRoot()
  fs.mkdirSync(path.dirname(live), { recursive: true })
  fs.cpSync(bundled, live, { recursive: true })
  const copied = inspectRuntime(live)
  if (!copied) throw new Error('运行时拷贝失败: 内置运行时缺失或损坏')
  copied.source = 'live'
  return copied
}
