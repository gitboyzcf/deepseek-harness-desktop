import type { ElectrobunConfig } from "electrobun";

// 开发时设 SKIP_RUNTIME_COPY=1 跳过运行时拷贝(1.7万文件, 每次构建 ~7 分钟);
// dev 模式下 resolveRuntime 会自动回退到项目 resources/runtime
const copyRuntime = process.env.SKIP_RUNTIME_COPY !== "1";

export default {
	app: {
		name: "DeepSeek Harness",
		identifier: "io.github.gitboyzcf.deepseek-harness-desktop",
		version: "0.1.4",
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
			"resources/icon.png": "views/mainview/logo.png",
			"build/icon.ico": "views/mainview/icon.ico",
			// 便携 Node + 预装 dsh 内核(构建前先跑 pnpm prepare:runtime)
			...(copyRuntime ? { "resources/runtime": "runtime" } : {}),
		},
		// 构建输出避开 build/(里面有 git 跟踪的图标等构建资源): 产物进 out/, 发行物进 dist/
		buildFolder: "out",
		artifactFolder: "dist",
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
	// 差分更新源: 浮动 latest Release(CI 每次发版把平铺更新文件传到这里, 客户端永远从这里拿最新)
	release: {
		baseUrl:
			"https://github.com/gitboyzcf/deepseek-harness-desktop/releases/download/latest",
	},
} satisfies ElectrobunConfig;
