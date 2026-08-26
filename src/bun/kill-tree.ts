import { spawnSync } from "node:child_process";

/**
 * 跨平台杀掉整个进程树。
 * Windows: taskkill /T 杀整棵树; POSIX: 对进程组发信号(Bun.spawn 默认独立进程组)。
 *
 * 注意必须用 spawnSync: 本函数的典型调用时机是应用退出前,
 * 异步 spawn 可能在事件循环停止前来不及真正创建 taskkill 进程, 导致子进程泄漏。
 */
export function killTree(pid: number | undefined): void {
	if (!pid) return;
	if (process.platform === "win32") {
		try {
			spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			/* 进程可能已退出 */
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				/* 进程可能已退出 */
			}
		}
	}
}
