/** 主进程(bun)与加载页(webview)共享的 RPC schema */
import type { DshStatus } from "../bun/dsh-manager";

export type DshRpcSchema = {
	bun: {
		requests: {
			/** 加载页"重试"按钮: 重启 dsh 服务 */
			retry: { params: Record<string, never>; response: void };
		};
		messages: Record<string, never>;
	};
	webview: {
		requests: Record<string, never>;
		messages: {
			/** bun → 加载页: 服务状态变化 */
			status: DshStatus;
			/** bun → 加载页: 追加一行日志 */
			log: string;
		};
	};
};
