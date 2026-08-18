# DeepSeek Harness Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面客户端(Electron 套壳)。

**一台全新的电脑, 只需要安装这一个客户端, 双击图标即可使用 DeepSeek Harness 的 Web 界面** —— 不需要装 Node.js、不需要开终端、不需要敲任何命令。

## 它是怎么工作的

```
┌─ Electron 主进程 ─────────────────────────────────────┐
│ 1. 安装包内置 portable Node.js + 预装好的 @deepseek-ai/dsh │
│ 2. 启动时用内置 Node 拉起 `dsh web --port 0`(端口自动分配) │
│ 3. 从子进程输出解析出本地地址, 加载到窗口                 │
│ 4. 后台静默检查 npm 上的 dsh 新版本, 有则自动升级         │
│    (升级写入用户目录的可写副本, 下次启动生效)             │
│ 5. 退出时杀掉整个子进程树, 不留残留                       │
└──────────────────────────────────────────────────────┘
```

界面 100% 是 DeepSeek Harness 官方 Web UI, 本仓库只做"发行渠道"。

## 自动化更新(双层)

| 层 | 机制 | 需要你做什么 |
| --- | --- | --- |
| dsh 内核 | 客户端每次启动后后台比对 npm registry 版本, 自动升级 | 什么都不用做 |
| 客户端本体 | GitHub Action 每天检查上游 dsh 版本, 有新版自动构建安装包并发 Release; 老用户经 electron-updater 自动更新 | 什么都不用做 |

流水线见 [.github/workflows/release.yml](.github/workflows/release.yml)。

## 开发

```bash
pnpm install            # 安装依赖
pnpm prepare:runtime    # 首次: 下载 portable Node + 预装 dsh 到 resources/runtime
pnpm dev                # 开发模式
```

## 本地打包

```bash
pnpm build:win          # 产出 dist/ 下的 NSIS 安装包(需先 prepare:runtime)
```

## 目录结构

```
src/main/          Electron 主进程
  index.ts         生命周期 / 窗口 / 单实例 / 自动更新
  dsh-manager.ts   dsh web 子进程的拉起、输出解析、守护
  dsh-updater.ts   npm 版本比对与后台升级
  runtime.ts       运行时路径解析(内置只读副本 vs 用户目录可写副本)
  kill-tree.ts     跨平台进程树清理
src/preload/       预加载脚本(暴露 dsh 状态 IPC)
src/renderer/      极简加载页(状态 + 日志 + 重试)
scripts/prepare-runtime.mjs   构建期: 下载 Node + 预装 dsh
dsh-runtime.version           当前内置的 dsh 版本(CI 比对基准)
```

## License

MIT。DeepSeek Harness 本体亦为 MIT, 见其仓库。
