/**
 * 构建期运行时准备脚本:
 *   1. 下载平台对应的 portable Node.js → resources/runtime/node
 *   2. 在 resources/runtime/dsh 中预装 @deepseek-ai/dsh (生产依赖)
 *   3. 写入 resources/runtime/dsh-version.txt (CI 用来和上游比对)
 *
 * 用法: node scripts/prepare-runtime.mjs [--force]
 * 本地开发 / CI 打包前都必须先跑一次 (CI 里自动跑)。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_DIR = path.join(ROOT, 'resources', 'runtime')
const NODE_DIR = path.join(RUNTIME_DIR, 'node')
const DSH_DIR = path.join(RUNTIME_DIR, 'dsh')
const VERSION_FILE = path.join(RUNTIME_DIR, 'dsh-version.txt')

const NODE_MAJOR = process.env.DSH_NODE_MAJOR || '22'
const NPM_REGISTRY = process.env.NPM_REGISTRY || 'https://registry.npmmirror.com'
const NODE_MIRROR = process.env.NODE_MIRROR || 'https://registry.npmmirror.com/-/binary/node'

const PLATFORM_MAP = {
  win32: { pattern: /-win-x64\.zip$/, archive: 'zip' },
  darwin: { pattern: /-darwin-arm64\.tar\.gz$/, archive: 'tar.gz' },
  linux: { pattern: /-linux-x64\.tar\.xz$/, archive: 'tar.xz' }
}

const force = process.argv.includes('--force')

/**
 * Windows 上优先使用系统自带的 bsdtar(支持 zip);
 * git-bash 的 GNU tar 不解 zip, 且会把 "C:" 路径当远程主机。
 */
const TAR =
  process.platform === 'win32' && fs.existsSync('C:\\Windows\\System32\\tar.exe')
    ? 'C:\\Windows\\System32\\tar.exe'
    : 'tar'

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.json()
}

async function download(url, dest) {
  console.log(`[prepare] 下载 ${url}`)
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

/** 解析 latest-v{major}.x 目录列表, 取当前平台最新版本的压缩包 */
async function resolveNodeArtifact() {
  const channel = `latest-v${NODE_MAJOR}.x`
  const { pattern } = PLATFORM_MAP[process.platform] ?? {}
  if (!pattern) throw new Error(`暂不支持的平台: ${process.platform}`)
  const listing = await fetchJson(`${NODE_MIRROR}/${channel}/`)
  const candidates = listing
    .map((f) => {
      const m = f.name.match(/node-v(\d+)\.(\d+)\.(\d+)/)
      return m && pattern.test(f.name) ? { name: f.name, ver: [+m[1], +m[2], +m[3]] } : null
    })
    .filter(Boolean)
    .sort((a, b) => b.ver[0] - a.ver[0] || b.ver[1] - a.ver[1] || b.ver[2] - a.ver[2])
  if (!candidates.length) throw new Error(`在 ${channel} 中未找到匹配 ${pattern} 的 Node 发行包`)
  const { name } = candidates[0]
  return { url: `${NODE_MIRROR}/${channel}/${name}`, name }
}

async function prepareNode() {
  const nodeExe = path.join(NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'bin/node')
  if (fs.existsSync(nodeExe) && !force) {
    console.log('[prepare] Node 运行时已存在, 跳过')
    return
  }
  const { url, name } = await resolveNodeArtifact()
  // 注意: git-bash 的 GNU tar 会把路径中的 "C:" 当成远程主机, 这里统一切到临时目录后用相对路径
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-node-'))
  const archive = path.join(workDir, name)
  const extractDir = path.join(workDir, 'extract')

  await download(url, archive)
  fs.mkdirSync(extractDir, { recursive: true })
  // Windows 10+ / macOS / Linux 均自带 tar(bsdtar/GNU tar), 可解 zip 与 tar.*
  execFileSync(TAR, ['-xf', name, '-C', 'extract'], { stdio: 'inherit', cwd: workDir })

  const inner = fs.readdirSync(extractDir).find((d) => d.startsWith('node-'))
  if (!inner) throw new Error('解压后未找到 node-* 目录')
  fs.rmSync(NODE_DIR, { recursive: true, force: true })
  fs.mkdirSync(RUNTIME_DIR, { recursive: true })
  // 临时目录可能在不同盘符(C: → D:), rename 会 EXDEV, 用拷贝代替
  fs.cpSync(path.join(extractDir, inner), NODE_DIR, { recursive: true })
  fs.rmSync(workDir, { recursive: true, force: true })
  console.log(`[prepare] Node 运行时就绪: ${NODE_DIR}`)
}

function prepareDsh() {
  const stamp = fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : ''
  if (stamp && !force) {
    console.log(`[prepare] dsh 已预装 (v${stamp}), 跳过`)
    return
  }
  // 清干净再装: Windows 上 npm 遇到残留 node_modules 容易 ENOTEMPTY/EPERM
  fs.rmSync(DSH_DIR, { recursive: true, force: true })
  fs.mkdirSync(DSH_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(DSH_DIR, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-runtime',
        private: true,
        version: '0.0.0',
        dependencies: { '@deepseek-ai/dsh': 'latest' }
      },
      null,
      2
    )
  )
  let lastError
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`[prepare] 安装 @deepseek-ai/dsh (第 ${attempt} 次, 可能需要几分钟)…`)
      execFileSync(
        'npm',
        ['install', '--omit=dev', '--no-audit', '--no-fund', `--registry=${NPM_REGISTRY}`],
        { cwd: DSH_DIR, stdio: 'inherit', shell: process.platform === 'win32' }
      )
      lastError = null
      break
    } catch (err) {
      lastError = err
      console.warn(`[prepare] 安装失败, 清理后重试: ${err.message}`)
      fs.rmSync(path.join(DSH_DIR, 'node_modules'), { recursive: true, force: true })
      fs.rmSync(path.join(DSH_DIR, 'package-lock.json'), { force: true })
    }
  }
  if (lastError) throw lastError
  const pkg = JSON.parse(
    fs.readFileSync(path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8')
  )
  fs.writeFileSync(VERSION_FILE, pkg.version)
  console.log(`[prepare] dsh v${pkg.version} 预装完成`)
}

await prepareNode()
prepareDsh()
console.log('[prepare] 运行时准备完毕 →', RUNTIME_DIR)
