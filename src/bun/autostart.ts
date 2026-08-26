import { spawnSync } from "node:child_process";

const AUTORUN_VALUE = "DeepSeekHarness";
const AUTORUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

/**
 * Windows: 直写 HKCU Run 键(无需管理员权限)。
 * 不用 Electron 的 setLoginItemSettings 那套 —— 实测在打包应用上静默失败。
 * mac/linux 暂未实现(后续可用 electrobun 的 login item 能力或平台原生方式补)。
 */
export function setAutoStart(enabled: boolean): void {
	try {
		if (process.platform !== "win32") return;
		if (enabled) {
			spawnSync(
				"reg",
				[
					"add",
					AUTORUN_KEY,
					"/v",
					AUTORUN_VALUE,
					"/t",
					"REG_SZ",
					"/d",
					`"${process.execPath}" --hidden`,
					"/f",
				],
				{ windowsHide: true },
			);
		} else {
			spawnSync("reg", ["delete", AUTORUN_KEY, "/v", AUTORUN_VALUE, "/f"], {
				windowsHide: true,
			});
		}
	} catch {
		/* 注册表不可写时不影响主流程 */
	}
}

export function getAutoStart(): boolean {
	try {
		if (process.platform !== "win32") return false;
		const r = spawnSync("reg", ["query", AUTORUN_KEY, "/v", AUTORUN_VALUE], {
			windowsHide: true,
		});
		return r.status === 0;
	} catch {
		return false;
	}
}
