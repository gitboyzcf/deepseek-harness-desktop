import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { killTree } from "./kill-tree";
import type { RuntimeInfo } from "./runtime";

export interface DshStatus {
	state: "starting" | "running" | "error" | "stopped";
	message: string;
	url?: string;
}

const READY_PATTERN = /dsh web:\s*(https?:\/\/\S+)/i;
const START_TIMEOUT_MS = 90_000;

/**
 * 负责拉起 / 守护 `dsh web` 子进程。
 * 事件: 'status' (DshStatus), 'log' (string)
 */
export class DshManager extends EventEmitter {
	private child: ReturnType<typeof Bun.spawn> | null = null;
	private url: string | null = null;
	private stopping = false;
	private readyTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly runtime: RuntimeInfo) {
		super();
	}

	getUrl(): string | null {
		return this.url;
	}

	/** 探测当前 dsh 的 web profile 是否支持 --no-open(读定义启动参数的小文件, 一次启动只读一次) */
	private supportsNoOpen(): boolean {
		try {
			const startup = join(
				this.runtime.dshDir,
				"node_modules",
				"@deepseek-ai",
				"dsh-web-app",
				"lib",
				"startup.js",
			);
			return (
				existsSync(startup) &&
				readFileSync(startup, "utf8").includes("no-open")
			);
		} catch {
			return false;
		}
	}

	start(): void {
		if (this.child) return;
		this.stopping = false;
		this.url = null;
		this.emitStatus({ state: "starting", message: "正在启动 DeepSeek Harness 服务…" });

		// --no-open 是 dsh 0.1.1 才加的: 按能力探测, 老版本传了会直接 unknown option 崩掉
		const args = [this.runtime.dshBin, "web", "--port", "0", "--host", "127.0.0.1"];
		if (this.supportsNoOpen()) args.push("--no-open");

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn([this.runtime.nodeExe, ...args], {
				cwd: this.runtime.dshDir,
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (err) {
			this.emitStatus({
				state: "error",
				message: `无法启动服务进程: ${(err as Error).message}`,
			});
			return;
		}
		this.child = proc;

		// dsh 就绪前自身一行日志都不打(冷启动时空白可达 30s+), 主进程每 10s 打一次心跳, 避免加载页看起来像死了
		const startedAt = Date.now();
		const heartbeat = setInterval(() => {
			if (this.url) return;
			const waited = Math.round((Date.now() - startedAt) / 1000);
			this.emit(
				"log",
				`服务启动中, 已等待 ${waited}s (重启后首次启动需读取运行时文件, 可能较慢)…`,
			);
		}, 10_000);
		const stopHeartbeat = (): void => clearInterval(heartbeat);

		const readStream = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
			const decoder = new TextDecoder();
			// DOM 的 ReadableStream 类型缺 asyncIterator(Bun 运行时是支持的), 断言为 AsyncIterable
			for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
				for (const line of decoder.decode(chunk).split("\n")) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					this.emit("log", trimmed);
					const m = trimmed.match(READY_PATTERN);
					if (m && !this.url) {
						this.url = m[1];
						stopHeartbeat();
						if (this.readyTimer) clearTimeout(this.readyTimer);
						this.emitStatus({ state: "running", message: "服务已就绪", url: this.url });
					}
				}
			}
		};
		void readStream(proc.stdout as ReadableStream<Uint8Array>);
		void readStream(proc.stderr as ReadableStream<Uint8Array>);

		void proc.exited.then((code) => {
			stopHeartbeat();
			if (this.readyTimer) clearTimeout(this.readyTimer);
			this.child = null;
			if (this.stopping) {
				this.emitStatus({ state: "stopped", message: "服务已停止" });
			} else {
				this.emitStatus({
					state: "error",
					message: this.url
						? `服务意外中断 (退出码 ${code})`
						: `服务未能启动 (退出码 ${code})`,
				});
			}
		});

		this.readyTimer = setTimeout(() => {
			if (!this.url && this.child) {
				this.emitStatus({
					state: "error",
					message: `服务启动超时 (${START_TIMEOUT_MS / 1000}s)`,
				});
			}
		}, START_TIMEOUT_MS);
	}

	stop(): void {
		this.stopping = true;
		if (this.readyTimer) clearTimeout(this.readyTimer);
		if (this.child?.pid) {
			killTree(this.child.pid);
			this.child = null;
		}
	}

	restart(): void {
		this.stop();
		// 给旧进程一点退出时间再拉起
		setTimeout(() => this.start(), 500);
	}

	private emitStatus(status: DshStatus): void {
		this.emit("status", status);
	}
}
