// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 站点图标解析。
 *
 * 搜索 provider 只有 DeepSeek 会返回 `site_icon`，其余 provider 都没有图标字段。
 * 为了在卡片上显示**真实图标**而不是字母占位，这里按优先级给出候选 URL，
 * 由 `<img>` 逐个尝试，全部失败才回退到字母块。
 */

/** 解析成功的 hostname 缓存，避免同一站点在多张卡片里重复探测。 */
const resolvedByHost = new Map<string, string>();

/** 取出用于图标请求的主机名（保留 `www.`，部分站点只在该域名下提供图标）。 */
export function faviconHost(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}

/** 把解析结果记入缓存，供后续同站点卡片直接复用。 */
export function rememberFavicon(host: string, resolvedUrl: string): void {
    if (!host || !resolvedUrl) {
        return;
    }
    resolvedByHost.set(host, resolvedUrl);
}

/**
 * 组装某条来源的图标候选列表。
 *
 * 顺序刻意把「站点自己的 favicon」排在第三方服务前面：
 * 优先不把用户访问的站点泄露给图标 CDN，只有直连拿不到时才退到服务。
 *
 * 不缓存失败结果：网络瞬时不可用不应该让该站点本次会话永久没有图标，
 * 重复探测交给浏览器的 HTTP 缓存去吸收。
 */
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
        // 1) 站点自带图标：最准且不经第三方，但现代站点常把图标放在带哈希的路径，
        //    根路径会返回 SPA 的 HTML，`<img>` 解码失败会自动降级到下一候选。
        candidates.push(`https://${host}/favicon.ico`);
        // 2) Google 图标服务：会解析页面头的 <link rel="icon">，覆盖率最高。
        candidates.push(`https://www.google.com/s2/favicons?domain=${host}&sz=64`);
        // 3) DuckDuckGo 图标服务：作为备选，避免单一服务不可用时集体缺图标。
        candidates.push(`https://icons.duckduckgo.com/ip3/${host}.ico`);
    }

    return [...new Set(candidates)];
}
