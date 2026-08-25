import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface RuntimeInfo {
  /** node 可执行文件路径(不存在时回退为 PATH 中的 node) */
  nodeExe: string
  /** corepack.js 路径(用于经 corepack 调起 pnpm 升级 dsh; 不存在则为空串) */
  corepackCli: string
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
  const dshDir = path.join(root, 'dsh')
  const dshPkgPath = path.join(dshDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  if (!fs.existsSync(dshPkgPath)) return null
  // 防半截拷贝: 后台升级的材料化(cpSync)若被中断, 目录里可能有 package.json 但依赖不全,
  // 盲目采用会让 dsh 一启动就 ERR_MODULE_NOT_FOUND。抽查 bin.js 的首个直接依赖作为完整性探针。
  if (!fs.existsSync(path.join(dshDir, 'node_modules', 'commander', 'package.json'))) return null

  let version = '0.0.0'
  try {
    version = JSON.parse(fs.readFileSync(dshPkgPath, 'utf8')).version ?? version
  } catch {
    /* 忽略, 按未知版本处理 */
  }

  // node 运行时永不随 dsh 升级变化: live 副本不再拷贝 node 目录(省 ~94MB), 回退用安装包内置的。
  // 布局: Windows 解压后是 node/node.exe; mac/linux 官方包是 node/bin/node
  const nodeExe =
    [
      path.join(root, 'node', nodeBinName()),
      path.join(root, 'node', 'bin', nodeBinName()),
      path.join(bundledRuntimeRoot(), 'node', nodeBinName()),
      path.join(bundledRuntimeRoot(), 'node', 'bin', nodeBinName())
    ].find((p) => fs.existsSync(p)) ?? nodeBinName()
  // corepack 随 Node 发行版自带: Windows 在 node/node_modules, mac/linux 在 node/lib/node_modules
  const corepackCli =
    [
      path.join(root, 'node', 'node_modules', 'corepack', 'dist', 'corepack.js'),
      path.join(root, 'node', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
      path.join(bundledRuntimeRoot(), 'node', 'node_modules', 'corepack', 'dist', 'corepack.js'),
      path.join(bundledRuntimeRoot(), 'node', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js')
    ].find((p) => fs.existsSync(p)) ?? ''

  return {
    nodeExe,
    corepackCli,
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

/** 将内置运行时拷贝到用户目录(升级前置步骤)。只拷 dsh 目录(node 运行时直接复用内置的); 先拷临时目录再换名, 中断不留半截副本 */
export function materializeLiveRuntime(): RuntimeInfo {
  const live = liveRuntimeRoot()
  const existing = inspectRuntime(live)
  if (existing) {
    existing.source = 'live'
    return existing
  }
  const bundled = bundledRuntimeRoot()
  const staging = `${live}.staging-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(live), { recursive: true })
  try {
    fs.cpSync(path.join(bundled, 'dsh'), path.join(staging, 'dsh'), { recursive: true })
    fs.rmSync(live, { recursive: true, force: true })
    fs.renameSync(staging, live)
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw err
  }
  const copied = inspectRuntime(live)
  if (!copied) throw new Error('运行时拷贝失败: 内置运行时缺失或损坏')
  copied.source = 'live'
  return copied
}
