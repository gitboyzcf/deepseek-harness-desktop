/**
 * 精简 resources/runtime 体积(在 prepare-runtime 之后执行):
 *  - 删除 node_modules 中对运行时无用的文件: .map / .d.ts / .md / .pdb / tsconfig 等
 *  - 删除 test/docs/examples 目录
 *  - 删除 node-pty 的 arm64 预编译产物(安装包只发 x64)
 *
 * 用法: node scripts/prune-runtime.mjs
 * prepare-runtime.mjs 会在安装完 dsh 后自动调用本脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_NM = path.join(ROOT, 'resources', 'runtime', 'dsh', 'node_modules')

/** 按文件名后缀/全名匹配删除(后缀类删除是安全的: 运行时永远不会 require .map/.d.ts/.pdb) */
const FILE_KILL = ['.map', '.d.ts', '.pdb', '.markdown']
const FILE_NAMES = new Set(['.DS_Store'])

/**
 * 目录名删除只限【包根部】的测试/示例目录, 绝不递归进包内部:
 * 教训 —— yaml 包把运行时代码放在 dist/doc/ 里, 按名字递归删目录会误杀真实代码。
 */
const PKG_ROOT_DIRS = new Set(['test', 'tests', '__tests__', 'examples', 'example', '.github', 'coverage'])

let removedBytes = 0
let removedCount = 0

function rm(p) {
  try {
    const size = fs.statSync(p).isDirectory() ? dirSize(p) : fs.statSync(p).size
    fs.rmSync(p, { recursive: true, force: true })
    removedBytes += size
    removedCount++
  } catch {
    /* 忽略个别锁定/权限问题 */
  }
}

function dirSize(p) {
  let total = 0
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name)
    try {
      total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size
    } catch {
      /* skip */
    }
  }
  return total
}

/** 递归删除所有匹配后缀/全名的文件(不碰目录) */
function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      walk(full)
    } else {
      const lower = e.name.toLowerCase()
      if (FILE_NAMES.has(lower) || FILE_KILL.some((ext) => lower.endsWith(ext))) {
        rm(full)
      }
    }
  }
}

/** 只清理包根部的测试/示例目录 */
function prunePackageRootDirs() {
  for (const top of fs.readdirSync(DSH_NM)) {
    const topPath = path.join(DSH_NM, top)
    const pkgs = top.startsWith('@')
      ? fs.readdirSync(topPath).map((s) => path.join(topPath, s))
      : [topPath]
    for (const pkgDir of pkgs) {
      let entries
      try {
        entries = fs.readdirSync(pkgDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.isDirectory() && PKG_ROOT_DIRS.has(e.name)) rm(path.join(pkgDir, e.name))
      }
    }
  }
}

function pruneNodePty() {
  // node-pty 的多架构产物: 只保留 win32-x64
  const pty = path.join(DSH_NM, 'node-pty')
  for (const sub of [
    path.join('prebuilds', 'win32-arm64'),
    path.join('third_party', 'conpty') // 其下按版本号再分 win10-x64/arm64, 下面单独处理
  ]) {
    const full = path.join(pty, sub)
    if (sub.startsWith('third_party')) continue
    if (fs.existsSync(full)) rm(full)
  }
  const conptyRoot = path.join(pty, 'third_party', 'conpty')
  if (fs.existsSync(conptyRoot)) {
    for (const ver of fs.readdirSync(conptyRoot)) {
      const arm = path.join(conptyRoot, ver, 'win10-arm64')
      if (fs.existsSync(arm)) rm(arm)
    }
  }
  // 源码构建的中间产物(CI 上会触发 node-gyp 编译)
  const buildDir = path.join(pty, 'build')
  if (fs.existsSync(buildDir)) {
    for (const e of fs.readdirSync(buildDir)) {
      if (e !== 'Release') rm(path.join(buildDir, e))
    }
    const rel = path.join(buildDir, 'Release')
    if (fs.existsSync(rel)) {
      for (const e of fs.readdirSync(rel)) {
        // 保留 .node / .exe 等最终产物, 删除 obj 中间目录
        if (fs.statSync(path.join(rel, e)).isDirectory() && /obj/i.test(e)) rm(path.join(rel, e))
      }
    }
  }
}

if (!fs.existsSync(DSH_NM)) {
  console.error('[prune] 未找到 dsh node_modules, 跳过')
  process.exit(0)
}

walk(DSH_NM)
prunePackageRootDirs()
pruneNodePty()

console.log(`[prune] 清理完成: 删除 ${removedCount} 项, 释放 ${(removedBytes / 1048576).toFixed(1)} MB`)
