import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';
import WebSearchSourcesCard from '@/views/SearchView/components/ConversationPanel/components/WebSearchSourcesCard.vue';

vi.mock('@components/MotionCollapse.vue', () => ({
    default: {
        name: 'MotionCollapse',
        props: ['open'],
        template: '<div v-if="open"><slot /></div>',
    },
}));

function makeSources(count: number): WebSearchSource[] {
    return Array.from({ length: count }, (_, index) => ({
        id: `src-${index + 1}`,
        index: index + 1,
        title: `Source ${index + 1}`,
        url: `https://example${index + 1}.com/post`,
        snippet: `Snippet ${index + 1}`,
        siteName: `example${index + 1}.com`,
    }));
}

const BASE_PROPS = {
    verbText: '已搜索',
    summaryText: 'DeepSeek V4 什么时候发布 · DeepSeek',
    durationText: '611ms',
};

/** 推进若干帧，等缓动动画收尾。 */
async function settleFrames(count = 40): Promise<void> {
    for (let index = 0; index < count; index += 1) {
        await new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
        });
    }
}

describe('WebSearchSourcesCard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('keeps the original builtin tool line above the cards', () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(3) },
        });

        const line = wrapper.get('.tool-call-log-line').text();
        expect(line).toContain('已搜索');
        expect(line).toContain('DeepSeek V4 什么时候发布 · DeepSeek');
        expect(line).toContain('(611ms)');
    });

    it('renders the search engine as its own tag and drops it from the summary', () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(3), providerName: 'DeepSeek' },
        });

        // 引擎名从语义文本里移除，避免与标签重复
        expect(wrapper.get('.tool-call-log-content').text().trim()).toBe(
            'DeepSeek V4 什么时候发布'
        );
        expect(wrapper.get('.web-search-sources__engine').text()).toBe('DeepSeek');
        expect(wrapper.get('.tool-call-log-line').text()).toContain('(611ms)');
    });

    it('keeps the summary untouched when it does not carry the engine suffix', () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: {
                ...BASE_PROPS,
                summaryText: '今日新闻',
                sources: makeSources(2),
                providerName: 'AnySearch',
            },
        });

        expect(wrapper.get('.tool-call-log-content').text().trim()).toBe('今日新闻');
        expect(wrapper.get('.web-search-sources__engine').text()).toBe('AnySearch');
    });

    it('lays every source out in a single horizontal rail', () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(10) },
        });

        // 不再截断成「前几张 + 更多」，全部卡片都在同一个轨道里
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(10);
        expect(wrapper.find('.web-search-sources__card--more').exists()).toBe(false);
        expect(wrapper.find('.web-search-sources__card--less').exists()).toBe(false);
        expect(wrapper.get('[data-slot="web-search-sources"]').classes()).toContain(
            'web-search-sources__rail'
        );
    });

    it('shows skeleton placeholders with a shimmer while searching', () => {
        // 结果到位前轨道不能是空的，否则看着像「搜索没反应」。
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: [], searching: true },
        });

        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(4);
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(0);
        expect(wrapper.get('.web-search-sources__skeleton-shine').exists()).toBe(true);
    });

    it('drops the skeletons once the results arrive', async () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: [], searching: true },
        });
        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(4);

        await wrapper.setProps({ sources: makeSources(3), searching: false });

        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(0);
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(3);
    });

    it('does not show skeletons once the search finished without results', () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: [], searching: false },
        });

        expect(wrapper.findAll('[data-slot="web-search-skeleton"]')).toHaveLength(0);
    });

    it('is expanded by default and collapses on trigger click', async () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(3) },
        });

        expect(wrapper.get('.web-search-sources__trigger').attributes('aria-expanded')).toBe(
            'true'
        );
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(3);

        await wrapper.get('.web-search-sources__trigger').trigger('click');

        expect(wrapper.get('.web-search-sources__trigger').attributes('aria-expanded')).toBe(
            'false'
        );
        expect(wrapper.findAll('[data-slot="web-search-source"]')).toHaveLength(0);
    });

    it('does not fade either edge while the rail is not scrollable', () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(2) },
        });

        // 不可滚动时两端都不应该出现渐隐覆盖层
        expect(wrapper.find('.web-search-sources__fade--start').exists()).toBe(false);
        expect(wrapper.find('.web-search-sources__fade--end').exists()).toBe(false);
    });

    it('fades the leading edge once the rail is scrolled away from the start', async () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(10) },
        });

        const rail = wrapper.get('[data-slot="web-search-sources"]').element as HTMLElement;
        Object.defineProperty(rail, 'scrollWidth', { value: 900, configurable: true });
        Object.defineProperty(rail, 'clientWidth', { value: 300, configurable: true });
        rail.scrollLeft = 120;
        await wrapper.get('[data-slot="web-search-sources"]').trigger('scroll');

        // 已滚 120px > 上限 40px，左端取满
        expect(wrapper.get('.web-search-sources__fade--start').attributes('style')).toContain(
            'width: 40px'
        );
        // 还没滑到底，尾部也要渐隐
        expect(wrapper.get('.web-search-sources__fade--end').attributes('style')).toContain(
            'width: 40px'
        );
    });

    it('scales the leading fade with the actual scrolled distance', async () => {
        // 卡片几乎贴着轨道左缘，固定 40px 的渐隐只要残留几像素滚动
        // 就会把整张首卡抹掉，所以宽度必须跟着实际滚过的像素量走。
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(10) },
        });

        const rail = wrapper.get('[data-slot="web-search-sources"]').element as HTMLElement;
        Object.defineProperty(rail, 'scrollWidth', { value: 900, configurable: true });
        Object.defineProperty(rail, 'clientWidth', { value: 300, configurable: true });
        rail.scrollLeft = 6;
        await wrapper.get('[data-slot="web-search-sources"]').trigger('scroll');

        expect(wrapper.get('.web-search-sources__fade--start').attributes('style')).toContain(
            'width: 6px'
        );
    });

    it('drops the trailing fade once the rail reaches the end', async () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(10) },
        });

        const rail = wrapper.get('[data-slot="web-search-sources"]').element as HTMLElement;
        Object.defineProperty(rail, 'scrollWidth', { value: 900, configurable: true });
        Object.defineProperty(rail, 'clientWidth', { value: 300, configurable: true });
        rail.scrollLeft = 600; // 正好到底
        await wrapper.get('[data-slot="web-search-sources"]').trigger('scroll');

        expect(wrapper.get('.web-search-sources__fade--start').attributes('style')).toContain(
            'width: 40px'
        );
        expect(wrapper.find('.web-search-sources__fade--end').exists()).toBe(false);
    });

    it('clears the leading fade when the rail returns to the start', async () => {
        // 往回滑到底后，首卡必须完全可见
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(10) },
        });

        const rail = wrapper.get('[data-slot="web-search-sources"]').element as HTMLElement;
        Object.defineProperty(rail, 'scrollWidth', { value: 900, configurable: true });
        Object.defineProperty(rail, 'clientWidth', { value: 300, configurable: true });
        rail.scrollLeft = 0;
        await wrapper.get('[data-slot="web-search-sources"]').trigger('scroll');

        expect(wrapper.find('.web-search-sources__fade--start').exists()).toBe(false);
        expect(wrapper.get('.web-search-sources__fade--end').attributes('style')).toContain(
            'width: 40px'
        );
    });

    it('turns a vertical wheel into damped horizontal scrolling', async () => {
        // 浏览器不会把 deltaY 当成横向滚动，不转化的话用户会觉得「滑不动」；
        // 同时要阻尼：一格 120px 直接跳过去太粗暴。
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(10) },
        });
        const rail = wrapper.get('[data-slot="web-search-sources"]').element as HTMLElement;
        Object.defineProperty(rail, 'scrollWidth', { value: 900, configurable: true });
        Object.defineProperty(rail, 'clientWidth', { value: 300, configurable: true });

        const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
        rail.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);

        await settleFrames();

        // 120 * 0.5 = 60
        expect(Math.round(rail.scrollLeft)).toBe(60);
    });

    it('gives the wheel back to the page at the end of the rail', async () => {
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(10) },
        });
        const rail = wrapper.get('[data-slot="web-search-sources"]').element as HTMLElement;
        Object.defineProperty(rail, 'scrollWidth', { value: 900, configurable: true });
        Object.defineProperty(rail, 'clientWidth', { value: 300, configurable: true });
        rail.scrollLeft = 600;

        const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
        rail.dispatchEvent(event);

        // 到底后不吃掉事件，否则会话页面就滚不动了
        expect(event.defaultPrevented).toBe(false);
        expect(rail.scrollLeft).toBe(600);
    });

    it('clamps the final wheel step to the end instead of dropping it', async () => {
        // 最后一档经常会越过末端；直接丢掉会让轨道永远差几十像素滑不到尽头，
        // 最后一张卡片就会一直停在渐隐里。
        const wrapper = mount(WebSearchSourcesCard, {
            props: { ...BASE_PROPS, sources: makeSources(10) },
        });
        const rail = wrapper.get('[data-slot="web-search-sources"]').element as HTMLElement;
        Object.defineProperty(rail, 'scrollWidth', { value: 900, configurable: true });
        Object.defineProperty(rail, 'clientWidth', { value: 300, configurable: true });
        rail.scrollLeft = 590; // 距离末端 10px，阻尼后一档 60px 仍会越界

        const event = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true });
        rail.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);

        await settleFrames();

        expect(Math.round(rail.scrollLeft)).toBe(600);
        // 到尽头后尾部渐隐必须消失
        expect(wrapper.find('.web-search-sources__fade--end').exists()).toBe(false);
    });
});
