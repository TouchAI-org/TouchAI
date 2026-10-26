import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';
import WebSearchSourcesCard from '@/views/SearchView/components/ConversationPanel/components/WebSearchSourcesCard.vue';

/*
 * The existing webSearchSources test covers the log line, the rail layout, skeletons
 * and the scroll behaviour. What is left is the card's own content and the states a
 * user meets while a search is still running: collapsed by default, no fake sources,
 * the engine tag only when the search named one, and links that open safely.
 */

vi.mock('@components/MotionCollapse.vue', () => ({
    default: {
        name: 'MotionCollapse',
        props: ['open'],
        template: '<div v-if="open"><slot /></div>',
    },
}));

vi.mock('@/views/SearchView/components/WebSearch/SourceFavicon.vue', () => ({
    default: {
        name: 'SourceFavicon',
        props: ['source', 'size'],
        template: '<span class="favicon" :data-site="source?.url" />',
    },
}));

function source(overrides: Partial<WebSearchSource> = {}): WebSearchSource {
    return {
        id: 'src-1',
        index: 1,
        title: 'DeepSeek V4 release notes',
        url: 'https://docs.example.com/release',
        snippet: 'A snippet',
        siteName: 'docs.example.com',
        ...overrides,
    } as WebSearchSource;
}

const BASE_PROPS = {
    verbText: '已搜索',
    summaryText: 'DeepSeek V4 什么时候发布',
    durationText: '611ms',
};

function mountCard(props: Record<string, unknown> = {}) {
    return mount(WebSearchSourcesCard, {
        props: { ...BASE_PROPS, sources: [source()], ...props },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('user sees a source card they can open', () => {
    it('user sees the page title, its site and its position in the list', () => {
        const wrapper = mountCard({ sources: [source(), source({ id: 's2', index: 2 })] });

        const cards = wrapper.findAll('[data-slot="web-search-source"]');
        expect(cards[0]!.text()).toContain('DeepSeek V4 release notes');
        expect(cards[0]!.text()).toContain('docs.example.com');
        expect(cards[0]!.text()).toContain('1');
        expect(cards[1]!.text()).toContain('2');
    });

    it('user opens the source in a new window without leaking the current page', () => {
        const wrapper = mountCard();

        const card = wrapper.get('[data-slot="web-search-source"]');
        expect(card.attributes('href')).toBe('https://docs.example.com/release');
        expect(card.attributes('target')).toBe('_blank');
        expect(card.attributes('rel')).toBe('noreferrer');
    });

    it('user sees the host when the provider did not name the site', () => {
        const wrapper = mountCard({
            sources: [source({ siteName: undefined, url: 'https://news.example.org/post/1' })],
        });

        expect(wrapper.get('[data-slot="web-search-source"]').text()).toContain('news.example.org');
    });

    it('user sees an icon for every source', () => {
        const wrapper = mountCard({ sources: [source(), source({ id: 's2' })] });

        expect(wrapper.findAll('.favicon')).toHaveLength(2);
    });
});

describe('user opens a search result card that starts collapsed', () => {
    it('user does not see the sources until they expand the line', async () => {
        const wrapper = mountCard({ defaultOpen: false });

        expect(wrapper.get('.web-search-sources__trigger').attributes('aria-expanded')).toBe(
            'false'
        );
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(0);

        await wrapper.get('.web-search-sources__trigger').trigger('click');

        expect(wrapper.get('.web-search-sources__trigger').attributes('aria-expanded')).toBe(
            'true'
        );
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(1);
    });

    it('user gets an empty rail rather than fake sources when the search found nothing', async () => {
        const wrapper = mountCard({ sources: [], searching: false });

        await wrapper.get('.web-search-sources__trigger').trigger('click');

        // The line still says the search ran; there is simply nothing under it.
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(0);
        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(0);
        expect(wrapper.get('.tool-call-log-verb').text()).toBe('已搜索');
    });

    it('user sees the skeletons fill the rail while the first results are still coming', () => {
        const wrapper = mountCard({ sources: [], searching: true });

        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(4);
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(0);
    });
});

describe('user reads the search line without a translated payload', () => {
    it('user sees the raw payload text kept out of translation', () => {
        const wrapper = mountCard({ isSummaryPayload: true });

        expect(wrapper.get('.tool-call-log-content').attributes('translate')).toBe('no');
        expect(wrapper.get('.tool-call-log-content').attributes('data-no-i18n')).toBe('true');
    });

    it('user sees the summary translated when it is ordinary copy', () => {
        const wrapper = mountCard({ isSummaryPayload: false });

        expect(wrapper.get('.tool-call-log-content').attributes('translate')).toBeUndefined();
    });

    it('user sees no engine tag when the search did not report one', () => {
        const wrapper = mountCard();

        expect(wrapper.find('.web-search-sources__engine').exists()).toBe(false);
    });

    it('user sees no duration when the search did not report one', () => {
        const wrapper = mountCard({ durationText: null });

        expect(wrapper.get('.tool-call-log-line').text()).not.toContain('(');
    });

    it('user sees the line without a summary when the payload carried none', () => {
        const wrapper = mountCard({ summaryText: '   ' });

        expect(wrapper.get('.tool-call-log-verb').text()).toBe('已搜索');
        expect(wrapper.find('.tool-call-log-content').exists()).toBe(false);
    });
});

describe('user keeps a running search readable', () => {
    it('user sees skeletons appear in a staggered shimmer instead of all at once', () => {
        const wrapper = mountCard({ sources: [], searching: true });

        const skeletons = wrapper.findAll('[data-slot="web-search-skeleton"]');
        expect(skeletons).toHaveLength(4);
        const delays = skeletons.map((node) => node.attributes('style'));
        expect(new Set(delays).size).toBe(4);
    });

    it('user sees the finished sources in place of the skeletons', async () => {
        const wrapper = mountCard({ sources: [], searching: true });

        await wrapper.setProps({ sources: [source()], searching: false });

        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(0);
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(1);
    });

    it('user keeps a previously opened card open as results stream in', async () => {
        const wrapper = mountCard({ sources: [source()] });
        expect(wrapper.get('.web-search-sources__trigger').attributes('aria-expanded')).toBe(
            'true'
        );

        await wrapper.setProps({ searching: true });

        expect(wrapper.get('.web-search-sources__trigger').attributes('aria-expanded')).toBe(
            'true'
        );
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(1);
    });
});
