import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	inspectRuntime,
	liveRuntimeRoot,
	materializeLiveRuntime,
	type RuntimeInfo,
} from "./runtime";

/** 优先走国内镜像, 失败回退官方源 */
const REGISTRIES = ["https://registry.npmmirror.com", "https://registry.npmjs.org"];

async function getJson(
	url: string,
	timeoutMs = 8000,
): Promise<Record<string, unknown>> {
	const res = await fetch(url, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return (await res.json()) as Record<string, unknown>;
}

/** 查询 npm registry 上 dsh 的最新版本号 */
export async function fetchLatestDshVersion(): Promise<string | null> {
	for (const registry of REGISTRIES) {
		try {
			const data = await getJson(`${registry}/@deepseek-ai%2Fdsh/latest`);
			if (typeof data.version === "string") return data.version;
		} catch {
			/* 尝试下一个 registry */
		}
	}
	return null;
}

/** 与项目历史 packageManager 保持一致; corepack 按此规格下载/缓存 pnpm */
const PNPM_SPEC = "pnpm@10.32.1";

/** pnpm 默认屏蔽依赖安装脚本; 这些原生/构建型依赖必须放行, 与原先 npm 行为对齐 */
const ALLOWED_BUILD_DEPS = [
	"@deepseek-ai/dsh-subprocess-local",
	"@google/genai",
	"koffi",
	"node-pty",
	"protobufjs",
];

/** 确保 live 副本的 package.json 声明 onlyBuiltDependencies, 否则升级后 node-pty 等原生模块缺构建产物 */
function ensureBuildDepsAllowed(dshDir: string): void {
	try {
		const pkgPath = path.join(dshDir, "package.json");
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
		const existing: string[] = pkg.pnpm?.onlyBuiltDependencies ?? [];
		pkg.pnpm = {
			...(pkg.pnpm ?? {}),
			onlyBuiltDependencies: [...new Set([...existing, ...ALLOWED_BUILD_DEPS])],
		};
		writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
	} catch {
		/* 写不进去就按 pnpm 默认(不跑脚本)继续, 不阻断升级 */
	}
}

async function runPnpmInstall(
	runtime: RuntimeInfo,
	version: string,
	registry: string,
	log: (line: string) => void,
): Promise<void> {
	if (!runtime.corepackCli) {
		throw new Error("corepack 缺失, 无法升级");
	}
	ensureBuildDepsAllowed(runtime.dshDir);
	// 经 Node 自带的 corepack 调起 pnpm; hoisted 布局生成传统扁平 node_modules(打包/拷贝必需)
	const proc = Bun.spawn(
		[
			runtime.nodeExe,
			runtime.corepackCli,
			PNPM_SPEC,
			"add",
			`@deepseek-ai/dsh@${version}`,
			"--save-prod",
			"--save-exact",
			"--node-linker=hoisted",
			`--registry=${registry}`,
		],
		{
			cwd: runtime.dshDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				// corepack 首次下载 pnpm 也走同一镜像; 禁止交互式确认
				COREPACK_NPM_REGISTRY: registry,
				COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
			},
		},
	);
	const readStream = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		// DOM 的 ReadableStream 类型缺 asyncIterator(Bun 运行时是支持的), 断言为 AsyncIterable
		for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
			for (const line of decoder.decode(chunk).split("\n")) {
				if (line.trim()) log(`[升级] ${line.trim()}`);
			}
		}
	};
	await Promise.all([
		readStream(proc.stdout as ReadableStream<Uint8Array>),
		readStream(proc.stderr as ReadableStream<Uint8Array>),
	]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`pnpm 退出码 ${code}`);
}

export interface UpdateResult {
	updated: boolean;
	fromVersion: string;
	toVersion?: string;
	message: string;
}

/**
 * 检查并在后台升级 dsh 内核:
 * 1. 查 registry 最新版本; 2. 与当前运行版本比较;
 * 3. 需要升级时, 先将内置运行时拷贝到用户目录(内置目录只读), 再 pnpm 安装新版本。
 * 升级结果下次启动生效, 不打断当前会话。
 */
export async function checkAndUpdateDsh(
	current: RuntimeInfo,
	userData: string,
	log: (line: string) => void,
): Promise<UpdateResult> {
	const latest = await fetchLatestDshVersion();
	if (!latest) {
		return {
			updated: false,
			fromVersion: current.version,
			message: "无法获取最新版本信息(网络不可达)",
		};
	}
	if (latest === current.version) {
		return {
			updated: false,
			fromVersion: current.version,
			message: `已是最新版本 ${latest}`,
		};
	}

	log(`发现 dsh 新版本: ${current.version} → ${latest}, 开始后台升级…`);

	// live 副本可能不存在或版本落后, 统一以 live 为升级目标
	let live = inspectRuntime(liveRuntimeRoot(userData));
	if (!live || live.version === current.version) {
		// 当前跑的就是最新本地副本, 需要一份可写副本来升级
		live = materializeLiveRuntime(userData);
	}
	live.source = "live";

	// 升级期间停掉正在运行的服务会中断会话 —— 服务跑在哪个副本上只读使用, pnpm 覆盖 live 目录即可
	let lastError: Error | null = null;
	for (const registry of REGISTRIES) {
		try {
			await runPnpmInstall(live, latest, registry, log);
			const after = inspectRuntime(liveRuntimeRoot(userData));
			if (after && after.version === latest) {
				return {
					updated: true,
					fromVersion: current.version,
					toVersion: latest,
					message: `已升级到 ${latest}, 下次启动生效`,
				};
			}
			lastError = new Error("升级后版本校验未通过");
		} catch (err) {
			lastError = err as Error;
			log(`[升级] registry ${registry} 失败: ${lastError.message}`);
		}
	}
	return {
		updated: false,
		fromVersion: current.version,
		message: `升级失败: ${lastError?.message ?? "未知错误"}`,
	};
}
