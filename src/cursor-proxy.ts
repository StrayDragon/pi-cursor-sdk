import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ProxyAgent, request as undiciRequest } from "undici";

/**
 * Shared proxy config shape from ~/.pi/agent/x-proxy.json.
 *
 * @public
 */
export interface SharedProxyConfig {
	url?: string;
	httpsUrl?: string;
	noProxy?: string;
	noPrint?: boolean;
}

/**
 * 读取 ~/.pi/agent/x-proxy.json 中的共享代理配置。
 * 文件不存在或格式不对 → undefined。
 */
function loadSharedProxyConfig(): { config: SharedProxyConfig; sourcePath: string } | undefined {
	const path = join(getAgentDir(), "x-proxy.json");
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		const p = raw?.proxy;
		if (!p || typeof p !== "object") return undefined;
		const config: SharedProxyConfig = {};
		if (typeof p.url === "string" && p.url.trim()) config.url = p.url.trim();
		if (typeof p.httpsUrl === "string" && p.httpsUrl.trim())
			config.httpsUrl = p.httpsUrl.trim();
		if (typeof p.noProxy === "string" && p.noProxy.trim())
			config.noProxy = p.noProxy.trim();
		if (p.noPrint === true) config.noPrint = true;
		if (!config.url && !config.httpsUrl) return undefined;
		return { config, sourcePath: path };
	} catch {
		return undefined;
	}
}

/**
 * 用 undici.ProxyAgent + undici.request({ dispatcher }) 创建代理 fetch。
 *
 * - 根据 URL scheme 选择 http/https ProxyAgent
 * - 命中 noProxy 列表的请求走原始 fetch
 * - 缺少对应 dispatcher 时回退原始 fetch
 */
export function createProxiedFetch(
	original: typeof fetch,
	cfg: SharedProxyConfig,
): typeof fetch {
	const httpAgent = cfg.url ? new ProxyAgent(cfg.url) : undefined;
	const httpsAgent = cfg.httpsUrl ? new ProxyAgent(cfg.httpsUrl) : httpAgent;

	if (!httpAgent && !httpsAgent) return original;

	const noProxy = (cfg.noProxy ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);

	return async function proxiedFetch(input, init) {
		const req = new Request(input, init);
		const url = new URL(req.url);

		// noProxy 检查：精确匹配 hostname 或 .domain 后缀
		if (
			noProxy.some(
				(p) => url.hostname === p || url.hostname.endsWith("." + p),
			)
		) {
			return original(req);
		}

		const dispatcher =
			url.protocol === "https:"
				? (httpsAgent ?? httpAgent)
				: httpAgent;
		if (!dispatcher) return original(req);

		const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
		const result = await undiciRequest(url.href, {
			method: req.method,
			headers: Object.fromEntries(req.headers),
			body,
			signal: req.signal,
			dispatcher,
		});

		const hdrs = new Headers();
		for (const [k, v] of Object.entries(result.headers)) {
			if (v !== undefined) {
				hdrs.set(k, Array.isArray(v) ? v.join(", ") : v);
			}
		}
		return new Response(result.body, {
			status: result.statusCode,
			statusText: result.statusText ?? "",
			headers: hdrs,
		});
	};
}

/**
 * 配置 Cursor 扩展的 HTTP 代理。
 *
 * 从 ~/.pi/agent/x-proxy.json 读取共享代理配置。
 * 有 proxy 时：
 *   - 用 undici.ProxyAgent + undici.request({ dispatcher }) 创建代理 fetch
 *   - 替换 globalThis.fetch，不调用 setGlobalDispatcher
 *   - noPrint 不为 true 时打印一行到 stderr
 *
 * 必须在扩展启动时调用一次，在所有 fetch() 之前。
 */
export async function tryConfigureCursorProxy(): Promise<void> {
	const loaded = loadSharedProxyConfig();
	if (!loaded) return;

	const { config, sourcePath } = loaded;

	try {
		globalThis.fetch = createProxiedFetch(globalThis.fetch, config);

		if (!config.noPrint) {
			const label = sourcePath.replace(getAgentDir(), "~/.pi/agent");
			console.error(
				`[cursor-sdk] Proxy enabled (${label}): ${config.httpsUrl ?? config.url}`,
			);
		}
	} catch (e) {
		console.error("[cursor-sdk] Failed to configure proxy:", e);
	}
}
