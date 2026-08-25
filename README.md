# DeepSeek Harness Desktop

<p>
  <img src="build/icon.png" width="96" alt="logo" />
</p>

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌面客户端。装好双击图标就能用官方 Web 界面, 不用装 Node.js, 不用碰命令行。

## 下载

到 [Releases](https://github.com/gitboyzcf/deepseek-harness-desktop/releases) 页拿最新版:

- Windows: `DeepSeek-Harness-Setup-x.y.z.exe` (安装包, 可以自选安装目录)
- macOS (Apple Silicon): `.dmg`
- Linux: `.AppImage`

macOS 包没有签名, 首次打开需要在 Finder 里右键 → 打开。

## 使用

- 首次启动会拉起内置的 dsh 服务, 等几秒就进界面
- 关闭窗口只是最小化到系统托盘, 服务继续在后台跑; 再点图标直接回到界面
- 首次启动会询问是否开机自启, 默认开启。开启后每次开机会在后台先把服务预热好, 不弹窗
- 右键托盘图标可以随时更改开机自启, 或者彻底退出

## 工作原理

安装包里带了一份 portable Node.js 和预装好的 @deepseek-ai/dsh。启动时用内置 Node 拉起 `dsh web --port 0` (端口系统自动分配), 从子进程输出里解析出本地地址, 加载进窗口。界面就是 DeepSeek Harness 官方 Web UI, 这个仓库只负责打包和发行。

## 更新

dsh 内核和客户端本体分开更新, 都不需要用户动手:

- dsh 内核: 每次启动后后台比对 npm registry 上的版本, 有新版就通过 pnpm 装到用户目录下的可写副本, 下次启动生效, 不打断当前会话
- 客户端本体: GitHub Action 每天检查上游 dsh 有没有新版, 有就在 Windows / macOS / Linux 三个平台重新构建并发 Release; 老客户端通过 electron-updater 自动更新

流水线在 [.github/workflows/release.yml](.github/workflows/release.yml)。三个平台必须在各自的 runner 上原生构建, 因为内置 Node 和 node-pty 这类原生模块是平台相关的, 没法交叉编译。

## 开发

```bash
pnpm install            # 装依赖
pnpm prepare:runtime    # 首次: 下载 portable Node + 预装 dsh 到 resources/runtime
pnpm dev                # 开发模式
```

## 本地打包

```bash
pnpm build:win          # Windows 安装包 (需先 prepare:runtime)
pnpm build:mac          # 只能在 macOS 上跑
pnpm build:linux        # 只能在 Linux 上跑
```

## 目录结构

```
src/main/          Electron 主进程
  index.ts         生命周期 / 窗口 / 托盘 / 开机自启 / 自动更新
  dsh-manager.ts   dsh web 子进程的拉起、就绪探测、守护
  dsh-updater.ts   dsh 版本比对与后台升级 (corepack 调 pnpm)
  runtime.ts       运行时路径解析 (内置副本 vs 用户目录可写副本)
  kill-tree.ts     退出时清理整个子进程树
src/preload/       预加载脚本 (暴露 dsh 状态 IPC)
src/renderer/      加载页 (状态 + 日志 + 重试)
scripts/prepare-runtime.mjs   构建期: 下载 Node + pnpm 预装 dsh
dsh-runtime.version           当前内置的 dsh 版本 (CI 比对基准)
```

## 待办

- 移动端同步: 手机端与桌面端之间的会话/数据同步 (规划中, 方案未定)

## License

MIT。DeepSeek Harness 本体也是 MIT, 见其仓库。
