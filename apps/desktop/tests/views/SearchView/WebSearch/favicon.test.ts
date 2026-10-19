import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildFaviconCandidates,
    faviconHost,
    rememberFavicon,
} from '@/views/SearchView/components/WebSearch/favicon';

describe('favicon candidates', () => {
    // 模块级缓存是跨用例共享的，用不同 host 隔离
    let hostSeed = 0;
    const uniqueHost = () => `site-${(hostSeed += 1)}.example.com`;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('extracts the host, keeping www', () => {
        expect(faviconHost('https://www.example.com/a/b')).toBe('www.example.com');
        expect(faviconHost('not a url')).toBe('');
    });

    it('prefers the provider-supplied icon before any third party service', () => {
        const host = uniqueHost();
        const candidates = buildFaviconCandidates({
            url: `https://${host}/post`,
            favicon: 'https://cdn.example.com/icon.png',
        });

        expect(candidates[0]).toBe('https://cdn.example.com/icon.png');
        expect(candidates).toContain(`https://${host}/favicon.ico`);
        expect(candidates).toContain(`https://www.google.com/s2/favicons?domain=${host}&sz=64`);
        expect(candidates).toContain(`https://icons.duckduckgo.com/ip3/${host}.ico`);
    });

    it('tries the site favicon before falling back to icon services', () => {
        const host = uniqueHost();
        const candidates = buildFaviconCandidates({ url: `https://${host}/post` });

        expect(candidates.indexOf(`https://${host}/favicon.ico`)).toBeGreaterThanOrEqual(0);
        expect(candidates.indexOf(`https://${host}/favicon.ico`)).toBeLessThan(
            candidates.indexOf(`https://www.google.com/s2/favicons?domain=${host}&sz=64`)
        );
        expect(
            candidates.indexOf(`https://www.google.com/s2/favicons?domain=${host}&sz=64`)
        ).toBeLessThan(candidates.indexOf(`https://icons.duckduckgo.com/ip3/${host}.ico`));
    });

    it('returns only the resolved icon once a host succeeded', () => {
        const host = uniqueHost();
        const resolved = `https://${host}/favicon.ico`;
        rememberFavicon(host, resolved);

        expect(buildFaviconCandidates({ url: `https://${host}/other` })).toEqual([resolved]);
    });

    it('ignores empty resolution and tolerates urls without a host', () => {
        rememberFavicon('', 'https://example.com/icon.png');
        expect(buildFaviconCandidates({ url: 'not a url' })).toEqual([]);
    });
});
