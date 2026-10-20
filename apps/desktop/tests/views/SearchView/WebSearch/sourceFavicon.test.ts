import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';
import {
    buildFaviconCandidates,
    rememberFaviconFailure,
} from '@/views/SearchView/components/WebSearch/favicon';
import SourceFavicon from '@/views/SearchView/components/WebSearch/SourceFavicon.vue';

/** 每个用例用独立 host，避免模块级缓存互相污染。 */
let hostSeed = 0;
function makeSource(overrides: Partial<WebSearchSource> = {}): WebSearchSource {
    hostSeed += 1;
    return {
        id: `src-${hostSeed}`,
        index: 1,
        title: 'Example',
        url: `https://favicon-${hostSeed}.example.com/post`,
        ...overrides,
    };
}

/** 让 `<img>` 触发一次加载失败。 */
async function failImage(wrapper: ReturnType<typeof mount>): Promise<void> {
    const image = wrapper.find('img');
    expect(image.exists()).toBe(true);
    await image.trigger('error');
}

describe('SourceFavicon streaming stability', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('keeps the same candidates when the parent sends a new source object', async () => {
        // 流式输出时每个 chunk 都会下发新的 source 对象（字段相同、引用不同）。
        // 这里用同一份值的两份对象模拟，候选必须保持稳定。
        const source = makeSource();
        const wrapper = mount(SourceFavicon, { props: { source, size: 16 } });
        const before = buildFaviconCandidates(source);

        await wrapper.setProps({ source: { ...source }, size: 16 });

        const image = wrapper.find('img');
        expect(image.exists()).toBe(true);
        expect(image.attributes('src')).toBe(before[0]);
    });

    it('does not retry a failed favicon after the source object is replaced', async () => {
        // 回归：失败后父组件重发同值对象，曾把候选重置回失败的那张图，
        // 于是「字母块 → 试图 → 失败 → 字母块」无限循环（截图里的闪烁）。
        const source = makeSource();
        const wrapper = mount(SourceFavicon, { props: { source, size: 16 } });

        await failImage(wrapper);
        // 该站点只有一个候选，失败后应直接回退字母块
        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.text()).toBe('e');

        await wrapper.setProps({ source: { ...source }, size: 16 });

        // 换引用不能让失败的图标复活
        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.text()).toBe('e');
    });

    it('stays on the fallback for every subsequent streaming chunk', async () => {
        const source = makeSource();
        const wrapper = mount(SourceFavicon, { props: { source, size: 16 } });

        await failImage(wrapper);

        // 连续模拟多个流式 chunk
        for (let index = 0; index < 5; index += 1) {
            await wrapper.setProps({ source: { ...source }, size: 16 });
            expect(wrapper.find('img').exists()).toBe(false);
        }
    });

    it('shows a favicon that already rendered without waiting for a new load', () => {
        // 正文每个 chunk 都会重挂载行内引用；已成功过的图标不能先闪一下字母块。
        const source = makeSource();
        const first = mount(SourceFavicon, { props: { source, size: 16 } });
        first.find('img').trigger('load');

        const second = mount(SourceFavicon, { props: { source, size: 16 } });

        // 直接就是图片，没有字母块叠在上面
        expect(second.find('img').exists()).toBe(true);
        expect(second.text()).toBe('');
    });

    it('remembers the failure across a remount', () => {
        const source = makeSource();
        const wrapper = mount(SourceFavicon, { props: { source, size: 16 } });
        // 直接标记失败（等价于 `<img>` 已经报过错）
        rememberFaviconFailure(buildFaviconCandidates(source)[0] ?? '');
        wrapper.unmount();

        const remounted = mount(SourceFavicon, { props: { source, size: 16 } });

        expect(remounted.find('img').exists()).toBe(false);
    });
});
