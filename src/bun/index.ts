import { BrowserView, BrowserWindow, Tray, Utils, app } from "electrobun/main";
import { electrobunEventEmitter } from "electrobun/main/events";
import { Updater } from "electrobun/main/updater";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAutoStart, setAutoStart } from "./autostart";
import { DshManager, type DshStatus } from "./dsh-manager";
import { checkAndUpdateDsh } from "./dsh-updater";
import { resolveRuntime } from "./runtime";
import { onSecondInstanceShow, tryAcquireSingleInstance } from "./single-instance";
import type { DshRpcSchema } from "../shared/rpc-schema";

/** 开机自启时以 --hidden 拉起: 只在后台预热 dsh 服务, 不弹窗 */
const startHidden = process.argv.includes("--hidden");
/** 托盘"退出"菜单置位, 用于区分"关窗口(最小化到托盘)"与"真正退出" */
let isQuitting = false;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let manager: DshManager | null = null;
let dshLoaded = false;

// 应用数据目录(electrobun 按 identifier 推导), 确保存在
const userData = Utils.paths.userData;
mkdirSync(userData, { recursive: true });

// stable 构建无控制台, 启动关键路径写 boot.log 便于排查
function bootLogFile(line: string): void {
	try {
		writeFileSync(join(userData, "boot.log"), `${new Date().toISOString()} ${line}\n`, {
			flag: "a",
		});
	} catch {
		/* ignore */
	}
}

const LOADING_VIEW = "views://mainview/index.html";

// ---------- RPC: 加载页 ↔ 主进程 ----------
const rpc = BrowserView.defineRPC<DshRpcSchema>({
	maxRequestTime: 60_000,
	handlers: {
		requests: {
			retry: () => {
				if (manager) manager.restart();
				else bootDsh();
			},
		},
		messages: {},
	},
});

function sendStatus(status: DshStatus): void {
	console.log("[dsh:status]", status.state, status.message, status.url ?? "");
	try {
		rpc.send.status(status);
	} catch {
		/* 加载页尚未挂载时丢弃, 状态会在页面就绪后由最新状态覆盖 */
	}
}

function sendLog(line: string): void {
	console.log("[dsh:log]", line);
	try {
		rpc.send.log(line);
	} catch {
		/* 同上 */
	}
}

function showLoadingPage(): void {
	dshLoaded = false;
	mainWindow?.webview.loadURL(LOADING_VIEW);
}

function createWindow(): void {
	mainWindow = new BrowserWindow({
		title: "DeepSeek Harness",
		url: LOADING_VIEW,
		rpc,
		frame: { width: 1440, height: 900, x: 80, y: 50 },
	});

	// 服务已在运行(托盘常驻期间)时直接进界面, 不再经过加载页
	const readyUrl = manager?.getUrl();
	if (readyUrl) {
		dshLoaded = true;
		mainWindow.webview.loadURL(readyUrl);
	}
}

/** 显示(或重建)主窗口并聚焦; 服务已就绪时秒开界面 */
function showMainWindow(): void {
	if (!mainWindow) {
		createWindow();
		return;
	}
	mainWindow.show();
}

function bootDsh(): void {
	const runtime = resolveRuntime(userData);
	bootLogFile(`resolveRuntime → ${runtime ? `${runtime.source} v${runtime.version} node=${runtime.nodeExe}` : "null"}`);
	if (!runtime) {
		sendStatus({
			state: "error",
			message: app.isPackaged
				? "运行时缺失或已损坏, 请重新安装客户端"
				: "运行时缺失: 请先执行 pnpm prepare:runtime",
		});
		return;
	}

	sendLog(
		`运行时: ${runtime.source === "live" ? "用户目录副本" : "安装包内置"} (dsh v${runtime.version})`,
	);

	manager = new DshManager(runtime);
	manager.on("log", sendLog);
	manager.on("status", (status: DshStatus) => {
		bootLogFile(`status=${status.state} ${status.message} ${status.url ?? ""}`);
		sendStatus(status);
		if (status.state === "running" && status.url && mainWindow) {
			dshLoaded = true;
			mainWindow.webview.loadURL(status.url);
			backgroundUpdate(runtime.version);
		}
		if (status.state === "error" && dshLoaded) {
			// 服务中断: 切回加载页展示错误与重试入口
			showLoadingPage();
		}
	});
	manager.start();
}

/** 服务就绪后在后台静默升级 dsh 内核, 下次启动生效 */
function backgroundUpdate(currentVersion: string): void {
	const runtime = resolveRuntime(userData);
	if (!runtime) return;
	sendLog(`后台检查 dsh 更新 (当前 v${currentVersion})…`);
	checkAndUpdateDsh(runtime, userData, sendLog)
		.then((result) => {
			sendLog(`[更新] ${result.message}`);
			if (result.updated)
				sendStatus({ state: "running", message: result.message });
		})
		.catch((err: Error) => sendLog(`[更新] 检查失败: ${err.message}`));
}

// ---------- 托盘 ----------

function setupTray(): void {
	tray = new Tray({ title: "", image: "views://mainview/icon.ico", width: 16, height: 16 });
	tray.on("tray-clicked", (event: unknown) => {
		const action = (event as { data?: { action?: string } })?.data?.action;
		if (action === "open" || !action) showMainWindow();
		if (action === "autostart") {
			setAutoStart(!getAutoStart());
			rebuildTrayMenu();
		}
		if (action === "quit") {
			isQuitting = true;
			Utils.quit();
		}
	});
	rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
	if (!tray) return;
	tray.setMenu([
		{ type: "normal", label: "打开 DeepSeek Harness", action: "open" },
		{ type: "divider" },
		{
			type: "normal",
			label: "开机自动启动",
			action: "autostart",
			enabled: app.isPackaged && process.platform === "win32",
			checked: getAutoStart(),
		},
		{ type: "divider" },
		{ type: "normal", label: "退出", action: "quit" },
	]);
}

// ---------- 开机自启(首次启动弹窗, 默认开启) ----------

/** 首次启动时让用户自行选择是否开机自启(默认开启); 选择结果之后以托盘菜单开关为准 */
async function promptAutoStart(): Promise<void> {
	if (!app.isPackaged || process.platform !== "win32") return;
	const marker = join(userData, "login-item-initialized");
	if (existsSync(marker)) return;
	const { response } = await Utils.showMessageBox({
		type: "question",
		title: "开机自动启动",
		message: "是否允许 DeepSeek Harness 开机自动启动？",
		detail:
			"开启后仅在后台预热服务(不弹窗), 之后双击图标即可秒开;\n随时可以右键托盘图标, 在菜单里更改此设置。",
		buttons: ["开启 (推荐)", "不开启"],
		defaultId: 0,
		cancelId: 0,
	});
	setAutoStart(response === 0);
	writeFileSync(marker, "");
	rebuildTrayMenu();
}

// ---------- 客户端自身更新(electrobun 差分更新) ----------

async function setupAutoUpdater(): Promise<void> {
	if (!app.isPackaged) return;
	try {
		const info = await Updater.checkForUpdate();
		if (!info.updateAvailable) {
			sendLog(`[客户端更新] 已是最新 (${info.version})`);
			return;
		}
		sendLog(`[客户端更新] 发现新版本 v${info.version}, 后台静默下载中…`);
		await Updater.downloadUpdate();
		sendLog(`[客户端更新] v${info.version} 下载完成`);
		const { response } = await Utils.showMessageBox({
			type: "info",
			title: "更新就绪",
			message: `新版本 v${info.version} 已就绪`,
			detail: "立即重启完成更新; 选择\"稍后\"则会在下次启动时自动生效。",
			buttons: ["立即重启更新", "稍后"],
			defaultId: 0,
			cancelId: 1,
		});
		if (response === 0) {
			manager?.stop();
			isQuitting = true;
			await Updater.applyUpdate();
		}
	} catch (err) {
		sendLog(`[客户端更新] ${(err as Error).message}`);
	}
}

// ---------- 启动流程 ----------

async function main(): Promise<void> {
	bootLogFile(`main() start, argv=${process.argv.join(" ")}`);
	bootLogFile(
		`userData=${userData} DSH_RUNTIME=${process.env.DSH_RUNTIME ?? "<unset>"} isPackaged=${app.isPackaged}`,
	);

	// 单实例: 重复打开时通知已有实例显示窗口, 自己退出
	const exit = await tryAcquireSingleInstance();
	if (exit) {
		exit();
		return;
	}
	onSecondInstanceShow(() => showMainWindow());

	// 关窗口 = 最小化到托盘, dsh 服务保持运行; 真正退出走托盘"退出"菜单
	electrobunEventEmitter.on("will-close", (event) => {
		if (!isQuitting && mainWindow && event.data.id === mainWindow.id) {
			event.response = { allow: false };
			mainWindow.hide();
		}
	});
	// 退出前务必杀掉 dsh 子进程树, 防止端口/进程残留
	electrobunEventEmitter.on("before-quit", () => {
		isQuitting = true;
		manager?.stop();
	});

	setupTray();
	if (!startHidden) {
		createWindow();
		void promptAutoStart();
	}
	bootDsh();
	void setupAutoUpdater();
}

void main();
