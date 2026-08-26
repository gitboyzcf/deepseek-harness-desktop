import { BrowserWindow, Tray, Utils } from "electrobun/main";

// spike: 直接复用 electron 项目准备好的便携 Node + dsh 运行时
const RUNTIME =
	process.env.DSH_RUNTIME ?? "D:/deepseek-harness-desktop/resources/runtime";
const NODE_EXE =
	process.env.DSH_NODE_EXE ?? `${RUNTIME}/node/node.exe`;
const DSH_DIR = process.env.DSH_DIR ?? `${RUNTIME}/dsh`;
const DSH_BIN = `${DSH_DIR}/node_modules/@deepseek-ai/dsh/lib/bin.js`;
const ICON = "D:/deepseek-harness-desktop/resources/icon.png";

const READY_PATTERN = /dsh web:\s*(https?:\/\/\S+)/i;

const win = new BrowserWindow({
	title: "DeepSeek Harness",
	url: "views://mainview/index.html",
	frame: { width: 1440, height: 900, x: 100, y: 60 },
});

// 托盘: 打开 / 退出
const tray = new Tray({ title: "", image: ICON, width: 16, height: 16 });
tray.setMenu([
	{ type: "normal", label: "打开 DeepSeek Harness", action: "open" },
	{ type: "divider" },
	{ type: "normal", label: "退出", action: "quit" },
]);
tray.on("tray-clicked", (event: unknown) => {
	const action = (event as { data?: { action?: string } })?.data?.action;
	if (action === "open") win.show();
	if (action === "quit") {
		dshProcess?.kill();
		Utils.quit();
	}
});

// 拉起 dsh web 子进程(便携 Node), 解析就绪地址后切页面
let dshProcess: ReturnType<typeof Bun.spawn> | null = null;

function bootDsh(): void {
	console.log("[dsh] spawning:", NODE_EXE, DSH_BIN);
	const proc = Bun.spawn([NODE_EXE, DSH_BIN, "web", "--port", "0", "--host", "127.0.0.1"], {
		cwd: DSH_DIR,
		stdout: "pipe",
		stderr: "pipe",
	});
	dshProcess = proc;

	const readStream = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			for (const line of decoder.decode(chunk).split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				console.log("[dsh]", trimmed);
				const m = trimmed.match(READY_PATTERN);
				if (m) {
					console.log("[dsh] ready:", m[1]);
					win.webview.loadURL(m[1]);
				}
			}
		}
	};
	void readStream(proc.stdout as ReadableStream<Uint8Array>);
	void readStream(proc.stderr as ReadableStream<Uint8Array>);

	void proc.exited.then((code) => console.log("[dsh] exited:", code));
}

bootDsh();
console.log("spike app started");
