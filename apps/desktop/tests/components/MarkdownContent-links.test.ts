import { installProductAnalytics } from '@tests/utils/productAnalytics';
import { mockTauriCommand } from '@tests/utils/tauri';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { WEB_SEARCH_CITATIONS_KEY } from '@/views/SearchView/components/WebSearch/citations';

enableAutoUnmount(afterEach);
vi.setConfig({ testTimeout: 60_000 });

/** 正文链接的站点图标来自真实来源表，测试只提供最小字段。 */
const source = {
    id: 's1',
    index: 1,
    title: 'A very long page title here',
    url: 'https://example.com/a',
    snippet: 'Snippet',
};

async function mountAnswer(
    content: string,
    options: { matchSource?: boolean } = {}
): Promise<ReturnType<typeof mount>> {
    const { default: MarkdownContent } = await import('@components/MarkdownContent.vue');
    const registry = {
        findByUrl: vi.fn((url: string) => (options.matchSource ? { ...source, url } : undefined)),
    };

    return mount(MarkdownContent, {
        props: { content, final: true },
        global: { provide: { [WEB_SEARCH_CITATIONS_KEY as symbol]: registry } },
    });
}

describe('user reads links in an answer', () => {
    beforeEach(() => {
        installProductAnalytics();
        setLocale('zh-CN');
        mockTauriCommand('write_clipboard_text', undefined);
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe() {}
                unobserve() {}
                disconnect() {}
            }
        );
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('user sees the site icon and the readable label on an external link', async () => {
        const wrapper = await mountAnswer('参见[官方文档](https://docs.example.com/guide)。');

        const link = wrapper.get('.web-search-link');
        expect(link.find('.web-search-link__icon').exists()).toBe(true);
        expect(link.text()).toContain('官方文档');
        expect(link.get('a').attributes('href')).toBe('https://docs.example.com/guide');
    }, 60_000);

    it('user sees an in-page anchor without a site icon', async () => {
        const wrapper = await mountAnswer('参见[小节](#section)。');

        expect(wrapper.find('.web-search-link').exists()).toBe(false);
        expect(wrapper.get('a').attributes('href')).toBe('#section');
    }, 60_000);

    it('user reads the full source title when a search result is cited', async () => {
        const wrapper = await mountAnswer('[引用](https://news.example.com/article)', {
            matchSource: true,
        });

        expect(wrapper.find('.web-search-link').exists()).toBe(false);
        expect(wrapper.get('.web-search-citation__label').text()).toBe(
            'A very long page title here'
        );
    }, 60_000);
});
