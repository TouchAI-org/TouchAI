import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';
import { buildFaviconCandidates } from '@/views/SearchView/components/WebSearch/favicon';
import SourceFavicon from '@/views/SearchView/components/WebSearch/SourceFavicon.vue';

let hostSeed = 0;
function makeSource(): WebSearchSource {
    hostSeed += 1;
    return {
        id: `src-${hostSeed}`,
        index: 1,
        title: 'Example',
        url: `https://favicon-stability-${hostSeed}.example.com/post`,
        favicon: `https://favicon-stability-${hostSeed}.example.com/provider.png`,
    };
}

async function failImage(wrapper: ReturnType<typeof mount>): Promise<void> {
    const image = wrapper.find('img');
    expect(image.exists()).toBe(true);
    await image.trigger('error');
}

/** 逐个失败到退为字母块：覆盖 provider 图标 → 站点 /favicon.ico 的降级链。 */
async function failAllImages(wrapper: ReturnType<typeof mount>): Promise<void> {
    while (wrapper.find('img').exists()) {
        await failImage(wrapper);
    }
}

describe('user sees a stable source icon while an answer streams', () => {
    it('user rebuilds candidates only when the url or favicon value changes', async () => {
        const source = makeSource();
        const wrapper = mount(SourceFavicon, { props: { source, size: 16 } });
        const expected = buildFaviconCandidates(source);

        for (let index = 0; index < 5; index += 1) {
            await wrapper.setProps({ source: { ...source }, size: 16 });
        }

        const image = wrapper.find('img');
        expect(image.exists()).toBe(true);
        expect(image.attributes('src')).toBe(expected[0]);
    });

    it('user stays on the letter fallback after a failed icon across streaming chunks', async () => {
        // 回归 #584
        const source = makeSource();
        const wrapper = mount(SourceFavicon, { props: { source, size: 16 } });

        await failAllImages(wrapper);
        expect(wrapper.find('img').exists()).toBe(false);

        for (let index = 0; index < 5; index += 1) {
            await wrapper.setProps({ source: { ...source }, size: 16 });
            expect(wrapper.find('img').exists()).toBe(false);
        }
    });

    it('user does not re-show a failed icon when the source genuinely changes', async () => {
        const source = makeSource();
        const wrapper = mount(SourceFavicon, { props: { source, size: 16 } });

        await failAllImages(wrapper);
        expect(wrapper.find('img').exists()).toBe(false);

        const otherSource = makeSource();
        await wrapper.setProps({ source: otherSource, size: 16 });

        const image = wrapper.find('img');
        expect(image.exists()).toBe(true);
        expect(image.attributes('src')).toBe(buildFaviconCandidates(otherSource)[0]);
    });
});
