// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 站点图标解析。
 *
 * 只有 DeepSeek 会返回 `site_icon`，其余 provider 没有图标字段。
 * 这里按优先级给出候选 URL，由 `<img>` 逐个尝试，全部失败才回退到字母块。
 *
 * 关键约束：结果是**跨组件实例**共享的。正文与来源卡片都是流式渲染的，
 * 每个 chunk 都会重新投影消息、重新挂载图标组件，所以「这张图标已经成功过 /
 * 已经失败过」必须记在模块级，否则每来一个 chunk 都会重试一次，
 * 用户看到的就是图标不停闪烁。
 */

/** 解析成功的 hostname 缓存，避免同站点在多张卡片里重复探测。 */
const resolvedByHost = new Map<string, string>();

type FaviconState = 'loaded' | 'failed';

/**
 * 图标 URL 的加载结果。
 *
 * - `loaded`：已经画出来过，组件重挂载时可以直接显示，不必再等一次 `load`。
 * - `failed`：确认加载失败，构建候选时直接跳过，不再反复重试。
 *
 * 上限只是兜底：一条会话里的站点数远达不到，超了按先进先出淘汰。
 */
const FAVICON_STATE_LIMIT = 512;
const stateByUrl = new Map<string, FaviconState>();

function setFaviconState(url: string, state: FaviconState): void {
    const trimmed = url?.trim();
    if (!trimmed) {
        return;
    }

    // 重新插入以刷新 Map 的插入顺序，淘汰时优先丢掉最久没更新的。
    stateByUrl.delete(trimmed);
    if (stateByUrl.size >= FAVICON_STATE_LIMIT) {
        const oldest = stateByUrl.keys().next().value;
        if (oldest !== undefined) {
            stateByUrl.delete(oldest);
        }
    }

    stateByUrl.set(trimmed, state);
}

/** 记住一个加载失败的图标，后续构建候选时直接跳过。 */
export function rememberFaviconFailure(url: string): void {
    setFaviconState(url, 'failed');
}

/** 记住一个已经画出来的图标，重挂载时可直接显示。 */
export function rememberFaviconLoaded(url: string): void {
    setFaviconState(url, 'loaded');
}

/** 该图标是否已经成功加载过。 */
export function isFaviconLoaded(url: string): boolean {
    return Boolean(url) && stateByUrl.get(url) === 'loaded';
}

/** 保留 `www.`：部分站点只在该域名下提供图标。 */
export function faviconHost(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

export function rememberFavicon(host: string, resolvedUrl: string): void {
    if (!host || !resolvedUrl) {
        return;
    }
    resolvedByHost.set(host, resolvedUrl);
}

/**
 * 第三方 favicon 服务的总开关，默认关闭。
 *
 * 启用后会把用户搜到的域名发给 Google / DuckDuckGo，属于元数据泄露。
 */
let remoteFaviconServicesEnabled = false;

/** 仅供设置层 / 测试切换第三方图标服务。 */
export function setRemoteFaviconServicesEnabled(enabled: boolean): void {
    remoteFaviconServicesEnabled = enabled;
}

/**
 * 组装图标候选：provider 图标 → 站点 /favicon.ico →（可选）第三方服务。
 *
 * 已知加载失败的候选会被过滤掉；全部失败时返回空数组（由组件渲染字母块）。
 */
export function buildFaviconCandidates(source: { url: string; favicon?: string }): string[] {
    const host = faviconHost(source.url);
    const cached = host ? resolvedByHost.get(host) : undefined;
    // 缓存也可能已经失效（站点换图 / 断网），失败过的不再复用。
    if (cached && stateByUrl.get(cached) !== 'failed') {
        return [cached];
    }

    const candidates: string[] = [];
    const explicit = source.favicon?.trim();
    if (explicit) {
        candidates.push(explicit);
    }

    if (host) {
        // 根路径常返回 SPA 的 HTML，`<img>` 解码失败会自动降级。
        candidates.push(`https://${host}/favicon.ico`);

        if (remoteFaviconServicesEnabled) {
            candidates.push(`https://www.google.com/s2/favicons?domain=${host}&sz=64`);
            candidates.push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
        }
    }

    return [...new Set(candidates)].filter((url) => stateByUrl.get(url) !== 'failed');
}
