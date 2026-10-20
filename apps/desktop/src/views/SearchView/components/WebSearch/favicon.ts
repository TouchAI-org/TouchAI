// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 站点图标解析。
 *
 * 只有 DeepSeek 会返回 `site_icon`，其余 provider 没有图标字段。
 * 这里按优先级给出候选 URL，由 `<img>` 逐个尝试，全部失败才回退到字母块。
 */

/** 解析成功的 hostname 缓存，避免同站点在多张卡片里重复探测；失败不缓存。 */
const resolvedByHost = new Map<string, string>();

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

/** 组装图标候选：provider 图标 → 站点 /favicon.ico →（可选）第三方服务。 */
export function buildFaviconCandidates(source: { url: string; favicon?: string }): string[] {
    const host = faviconHost(source.url);
    const cached = host ? resolvedByHost.get(host) : undefined;
    if (cached) {
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

    return [...new Set(candidates)];
}
