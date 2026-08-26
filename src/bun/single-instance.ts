/**
 * 单实例锁 + 实例间"显示窗口"信号。
 * 第一个实例监听 127.0.0.1 固定端口; 重复打开时第二个实例请求 /show 后退出,
 * 已有实例收到请求把窗口显示出来。
 * 端口被无关程序占用时退化为"允许多开", 不影响主流程。
 */

const LOCK_PORT = 47788;
const SHOW_PATH = "/dsh-desktop-show";

/** 尝试成为主实例。返回 null 表示成功(继续启动); 否则已通知已有实例并应退出 */
export async function tryAcquireSingleInstance(): Promise<
	null | (() => void)
> {
	let server: ReturnType<typeof Bun.serve> | null = null;
	try {
		server = Bun.serve({
			port: LOCK_PORT,
			hostname: "127.0.0.1",
			fetch(req) {
				if (new URL(req.url).pathname === SHOW_PATH) {
					onShowRequest?.();
					return new Response("ok");
				}
				return new Response("not found", { status: 404 });
			},
		});
	} catch {
		server = null;
	}

	if (!server) {
		// 已有实例: 通知它显示窗口, 然后自己退出
		try {
			await fetch(`http://127.0.0.1:${LOCK_PORT}${SHOW_PATH}`, {
				signal: AbortSignal.timeout(3000),
			});
		} catch {
			/* 端口被无关程序占用等情况, 静默退出 */
		}
		return () => process.exit(0);
	}

	return null;
}

let onShowRequest: (() => void) | null = null;
export function onSecondInstanceShow(handler: () => void): void {
	onShowRequest = handler;
}
