import { spawn } from 'node:child_process'
import https from 'node:https'
import path from 'node:path'
import { inspectRuntime, liveRuntimeRoot, materializeLiveRuntime, type RuntimeInfo } from './runtime'

/** 优先走国内镜像, 失败回退官方源 */
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

function getJson(url: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { accept: 'application/json' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`HTTP ${res.statusCode}`))
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch (err) {
          reject(err)
        }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

/** 查询 npm registry 上 dsh 的最新版本号 */
export async function fetchLatestDshVersion(): Promise<string | null> {
  for (const registry of REGISTRIES) {
    try {
      const data = await getJson(`${registry}/@deepseek-ai%2Fdsh/latest`)
      if (typeof data.version === 'string') return data.version
    } catch {
      /* 尝试下一个 registry */
    }
  }
  return null
}

function runNpmInstall(runtime: RuntimeInfo, version: string, registry: string, log: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!runtime.npmCli) {
      reject(new Error('npm-cli.js 缺失, 无法升级'))
      return
    }
    const child = spawn(
      runtime.nodeExe,
      [
        runtime.npmCli,
        'install',
        `@deepseek-ai/dsh@${version}`,
        '--omit=dev',
        '--no-audit',
        '--no-fund',
        `--registry=${registry}`
      ],
      { cwd: runtime.dshDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    )
    const onData = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (line.trim()) log(`[升级] ${line.trim()}`)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm install 退出码 ${code}`))))
  })
}

export interface UpdateResult {
  updated: boolean
  fromVersion: string
  toVersion?: string
  message: string
}

/**
 * 检查并在后台升级 dsh 内核:
 * 1. 查 registry 最新版本; 2. 与当前运行版本比较;
 * 3. 需要升级时, 先将内置运行时拷贝到用户目录(内置目录只读), 再 npm install 新版本。
 * 升级结果下次启动生效, 不打断当前会话。
 */
export async function checkAndUpdateDsh(
  current: RuntimeInfo,
  log: (line: string) => void
): Promise<UpdateResult> {
  const latest = await fetchLatestDshVersion()
  if (!latest) {
    return { updated: false, fromVersion: current.version, message: '无法获取最新版本信息(网络不可达)' }
  }
  if (latest === current.version) {
    return { updated: false, fromVersion: current.version, message: `已是最新版本 ${latest}` }
  }

  log(`发现 dsh 新版本: ${current.version} → ${latest}, 开始后台升级…`)

  // live 副本可能不存在或版本落后, 统一以 live 为升级目标
  let live = inspectRuntime(liveRuntimeRoot())
  if (!live || live.version === current.version) {
    // 当前跑的就是最新本地副本, 需要一份可写副本来升级
    live = materializeLiveRuntime()
  }
  live.source = 'live'

  // 升级期间停掉正在运行的服务会中断会话 —— 服务跑在哪个副本上只读使用, npm 覆盖 live 目录即可
  let lastError: Error | null = null
  for (const registry of REGISTRIES) {
    try {
      await runNpmInstall(live, latest, registry, log)
      const after = inspectRuntime(liveRuntimeRoot())
      if (after && after.version === latest) {
        return { updated: true, fromVersion: current.version, toVersion: latest, message: `已升级到 ${latest}, 下次启动生效` }
      }
      lastError = new Error('升级后版本校验未通过')
    } catch (err) {
      lastError = err as Error
      log(`[升级] registry ${registry} 失败: ${lastError.message}`)
    }
  }
  return { updated: false, fromVersion: current.version, message: `升级失败: ${lastError?.message ?? '未知错误'}` }
}

/** 供 CI / 调试使用: live 运行时目录路径 */
export function liveDshDir(): string {
  return path.join(liveRuntimeRoot(), 'dsh')
}
