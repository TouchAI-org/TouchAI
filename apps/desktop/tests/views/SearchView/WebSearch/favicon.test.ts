import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildFaviconCandidates,
    faviconHost,
    rememberFavicon,
    setRemoteFaviconServicesEnabled,
} from '@/views/SearchView/components/WebSearch/favicon';

describe('favicon candidates', () => {
    // 模块级缓存是跨用例共享的，用不同 host 隔离
    let hostSeed = 0;
    const uniqueHost = () => `site-${(hostSeed += 1)}.example.com`;

    beforeEach(() => {
        vi.clearAllMocks();
        // 默认关闭：第三方服务会把用户搜到的域名泄露给 CDN。
        setRemoteFaviconServicesEnabled(false);
    });

    afterEach(() => {
        setRemoteFaviconServicesEnabled(false);
    });

    it('user extracts the host, keeping www', () => {
        expect(faviconHost('https://www.example.com/a/b')).toBe('www.example.com');
        expect(faviconHost('not a url')).toBe('');
    });

    it('user prefers the provider-supplied icon, then the site favicon', () => {
        const host = uniqueHost();
        const candidates = buildFaviconCandidates({
            url: `https://${host}/post`,
            favicon: 'https://cdn.example.com/icon.png',
        });

        expect(candidates[0]).toBe('https://cdn.example.com/icon.png');
        expect(candidates).toContain(`https://${host}/favicon.ico`);
    });

    it('user does not contact third-party icon services by default', () => {
        const host = uniqueHost();
        const candidates = buildFaviconCandidates({ url: `https://${host}/post` });

        expect(candidates).toEqual([`https://${host}/favicon.ico`]);
        // 用精确 hostname 集合比较，不做子串/后缀匹配。
        const hosts = candidates.map((url) => new URL(url).hostname);
        expect(hosts).not.toContain('www.google.com');
        expect(hosts).not.toContain('icons.duckduckgo.com');
    });

    it('user uses third-party services only when explicitly enabled', () => {
        setRemoteFaviconServicesEnabled(true);
        const host = uniqueHost();
        const candidates = buildFaviconCandidates({ url: `https://${host}/post` });

        expect(candidates).toContain(`https://www.google.com/s2/favicons?domain=${host}&sz=64`);
        expect(candidates).toContain(`https://icons.duckduckgo.com/ip3/${host}.ico`);
        // 站点自身仍排在第三方前面
        expect(candidates.indexOf(`https://${host}/favicon.ico`)).toBeLessThan(
            candidates.indexOf(`https://www.google.com/s2/favicons?domain=${host}&sz=64`)
        );
    });

    it('user gets only the resolved icon once a host succeeded', () => {
        const host = uniqueHost();
        const resolved = `https://${host}/favicon.ico`;
        rememberFavicon(host, resolved);

        expect(buildFaviconCandidates({ url: `https://${host}/other` })).toEqual([resolved]);
    });

    it('user ignores empty resolution and tolerates urls without a host', () => {
        rememberFavicon('', 'https://example.com/icon.png');
        expect(buildFaviconCandidates({ url: 'not a url' })).toEqual([]);
    });
});
