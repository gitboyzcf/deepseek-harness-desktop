# Role: 资深 Electron 架构师

## 项目背景
我正在为开源项目 DeepSeek Harness（MIT 协议）开发一个 PC 客户端包装器。我需要你帮我生成一套完整的 Electron 应用骨架代码。

## 核心目标
实现一个“Thin Client”（瘦客户端），它本身不包含 DSH 源码，而是在用户电脑上动态拉取、构建并启动 DSH，并具备自动更新能力。

## 功能需求 (Must Have)
1. **初始化与拉取**：首次启动时，自动将官方 DSH 仓库(https://github.com/deepseek-ai/deepseek-harness)  克隆到当前项目根目录。
2. **自动构建**：克隆完成后，自动执行 https://github.com/deepseek-ai/deepseek-harness  文档中的使用方法去执行一系列对应命令（注意：DSH 是 Monorepo，需要处理 workspace）。
3. **启动与展示**：构建成功后，启动 DSH 的 Web 服务（`pnpm dsh web`），并在 Electron 的 `BrowserWindow` 中加载该本地 Web UI（`http://localhost:端口`）。
4. **增量更新**：每次用户打开客户端时，自动在后台执行 `git pull --rebase --autostash`，若有代码更新则自动重新构建，然后启动。
5. **版本自动更新**：集成 `electron-updater`，当我在 GitHub Releases 发布新版本时，客户端能检测并下载安装更新。

## 明确的边界与限制 (Constraints)
为了防止你过度设计或出错，请严格遵守以下边界：

1. **禁止修改 DSH 源码**：你的 Electron 代码只能作为“外部操作者”，不得修改 `deepseek-harness` 仓库里的任何文件内容（除了可能需要的 `.env` 配置）。
2. **端口处理**：不要写死端口。请通过读取 `pnpm run start:web` 输出的终端日志，或用 `find-free-port` 逻辑动态检测端口，并在端口被占用时自动杀掉旧进程。
3. **平台兼容**：代码必须兼容 Windows (PowerShell) 和 macOS/Linux (Bash)。请使用 `cross-env` 或 Node.js 的 `path` 和 `os` 模块处理路径差异，严禁使用硬编码的 `\` 或 `/`。
4. **子进程管理**：Electron 主进程退出时，必须确保 `pnpm start:web` 的子进程也被完全杀掉（`tree-kill` 或 `process.kill(-pid)`），防止端口长期占用。
5. **依赖管理**：不要假设用户全局安装了 `pnpm`。请在首次运行时，通过 Node.js 的 `npx pnpm@latest` 来执行所有 pnpm 命令。
6. **UI 简洁性**：只需要提供一个极简的加载状态窗口（显示“正在拉取代码”、“正在构建(进度条)”），不需要花哨的界面，重点放在逻辑的稳定性上。

## 输出要求
请提供完整的项目文件结构，并给出以下核心文件的具体代码：
- `main.js` (主进程)
- `preload.js` (预加载脚本)
- `renderer/index.html` 和 `renderer/renderer.js` (加载界面)
- `package.json` (包含必要的依赖和 scripts)
- 一个简单的 `config.json` 或环境变量处理逻辑（用于配置 Git 仓库地址）

## 额外注意
- 构建过程可能较长（>5分钟），请确保 UI 不会假死，主进程需保持响应。
- 请使用 ES Module (import/export) 或 CommonJS 均可，但需明确标注。
