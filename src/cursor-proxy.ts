import { loadCursorSdkUserConfig } from "./cursor-config.js";

/**
 * Configure undici global dispatcher with proxy settings.
 *
 * Reads from:
 *   1. (最高) ~/.pi/agent/cursor-sdk.json → proxy 字段
 *   2. (回退) HTTPS_PROXY / HTTP_PROXY / ALL_PROXY + NO_PROXY 环境变量
 *   3. 两者都没有 → 不启用
 *
 * 必须且只需在扩展启动时调用一次，在所有 fetch() 之前。
 */
export async function tryConfigureCursorProxy(): Promise<void> {
	// ── 1. 从扩展配置文件读取 ──────────────────────────────────
	const userConfig = loadCursorSdkUserConfig();
	const cfgProxy = userConfig?.proxy;

	// ── 2. 解析最终代理设置（配置 > 环境变量） ──────────────────
	const httpProxy = cfgProxy?.url ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? undefined;
	const httpsProxy = cfgProxy?.httpsUrl ?? cfgProxy?.url ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? undefined;
	const noProxyList = cfgProxy?.noProxy ?? process.env.NO_PROXY ?? process.env.no_proxy ?? undefined;

	const effectiveUrl = httpsProxy ?? httpProxy;
	if (!effectiveUrl) return; // 没有任何代理配置，跳过

	// ── 3. 设置 undici 全局代理 ────────────────────────────────
	try {
		// 用 import.meta.url 定位，不受 CWD 影响
		const undiciUrl = new URL(
			"../node_modules/@earendil-works/pi-coding-agent/node_modules/undici/index.js",
			import.meta.url,
		).href;
		const undici = await import(undiciUrl);

		// 构造参数：优先用配置值，留空则让 EnvHttpProxyAgent 从 env 读取
		const opts: Record<string, string | undefined> = {};
		if (httpProxy) opts.httpProxy = httpProxy;
		if (httpsProxy) opts.httpsProxy = httpsProxy;
		if (noProxyList) opts.noProxy = noProxyList;

		undici.setGlobalDispatcher(
			new undici.EnvHttpProxyAgent(Object.keys(opts).length > 0 ? opts : undefined),
		);

		const source = httpProxy === cfgProxy?.url || httpsProxy === cfgProxy?.httpsUrl ? "config" : "env";
		console.error(`[cursor-sdk] Proxy enabled (source=${source}): ${httpsProxy || httpProxy}`);
	} catch (e) {
		console.error("[cursor-sdk] Failed to configure proxy:", e);
	}
}
