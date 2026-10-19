import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';
import WebSearchCitation from '@/views/SearchView/components/WebSearch/WebSearchCitation.vue';

const source: WebSearchSource = {
    id: 's1',
    index: 1,
    title: 'Example page',
    url: 'https://example.com/a',
    snippet: 'Snippet',
};

/** 构造一个矩形。 */
function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
        left,
        top,
        right: left + width,
        bottom: top + height,
        width,
        height,
        x: left,
        y: top,
        toJSON: () => ({}),
    } as DOMRect;
}

const PREVIEW_SIZE = { width: 288, height: 96 };
let previewSize = PREVIEW_SIZE;
const CLIP = rect(0, 0, 750, 600);
/** 裁剪区（stub 里 body 的矩形），窄面板测试会改小它。 */
let clipRect = CLIP;

let chipRect = rect(100, 100, 18, 18);
/** 正文列的矩形（带 `data-content-column` 的容器），null 表示这个用例没有正文列约束。 */
let columnRect: DOMRect | null = null;
let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
/**
 * 预览在首帧的真实行为：元素已经进 DOM 但还没完成布局，
 * `getBoundingClientRect()` 返回 0。用户看到的溢出就是这种情况造成的。
 */
let previewMeasuresZero = false;

/**
 * 统一接管矩形测量：组件在打开时就量一次尺寸，
 * 所以必须在挂载前就把 chip / preview / 裁剪祖先的矩形准备好。
 */
function installRectStubs(): void {
    originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
        this: HTMLElement
    ) {
        if (this.classList.contains('web-search-citation')) {
            return chipRect;
        }
        if (this.getAttribute?.('role') === 'tooltip') {
            if (previewMeasuresZero) {
                return rect(chipRect.left, chipRect.top + 18, 0, 0);
            }
            return rect(chipRect.left, chipRect.top + 18, previewSize.width, previewSize.height);
        }
        if (this.dataset?.contentColumn === 'true' && columnRect) {
            return columnRect;
        }
        if (this === document.body) {
            return clipRect;
        }
        return originalGetBoundingClientRect.call(this);
    };
}

async function openPreview(wrapper: ReturnType<typeof mount>): Promise<void> {
    await wrapper.get('.web-search-citation').trigger('pointerenter', { pointerType: 'mouse' });
    vi.advanceTimersByTime(400);
    // 打开后 watcher 里还有 await nextTick()，要清空微任务队列才能等到布局计算
    await flushPromises();
}

function previewShift(wrapper: ReturnType<typeof mount>): number {
    const style = wrapper.get('[role="tooltip"]').attributes('style') ?? '';
    return Number(/margin-left:\s*(-?[\d.]+)px/.exec(style)?.[1] ?? '0');
}

describe('WebSearchCitation layout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // body 成为一个会裁剪的祖先，模拟会话面板
        document.body.style.overflow = 'hidden';
        clipRect = CLIP;
        columnRect = null;
        previewSize = PREVIEW_SIZE;
        previewMeasuresZero = false;
        installRectStubs();
    });

    afterEach(() => {
        vi.useRealTimers();
        HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        document.body.style.overflow = '';
        document.body.innerHTML = '';
    });

    it('shows the page title capped at 8 characters on the chip', () => {
        const wrapper = mount(WebSearchCitation, {
            props: {
                source: {
                    ...source,
                    title: '特朗普称进一步收紧对华先进技术出口管制',
                },
            },
        });

        const label = wrapper.get('.web-search-citation__label').text();
        // 8 个字 + 省略号
        expect(label).toBe('特朗普称进一步收…');
        expect(label.length).toBe(9);
    });

    it('keeps a short title as-is', () => {
        const wrapper = mount(WebSearchCitation, {
            props: { source: { ...source, title: 'BBC 中文' } },
        });

        expect(wrapper.get('.web-search-citation__label').text()).toBe('BBC 中文');
    });

    it('falls back to the site name when the title is missing', () => {
        const wrapper = mount(WebSearchCitation, {
            props: { source: { ...source, title: '' } },
        });

        expect(wrapper.get('.web-search-citation__label').text()).toBe('example');
    });

    it('shows only the favicon on a circular background', () => {
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: document.body });

        const chip = wrapper.get('.web-search-citation__chip');
        expect(chip.find('img').exists() || chip.text() === '').toBe(true);
        expect(wrapper.find('.web-search-citation__index').exists()).toBe(false);
    });

    it('keeps the preview in place while the chip is well inside the clip area', async () => {
        chipRect = rect(100, 100, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: document.body });

        await openPreview(wrapper);

        expect(previewShift(wrapper)).toBe(0);
        expect(wrapper.get('[role="tooltip"]').classes()).not.toContain(
            'web-search-citation__preview--above'
        );
    });

    it('pulls the preview back inside the clipping ancestor', async () => {
        // chip 贴着裁剪区右缘：750 - 18
        chipRect = rect(732, 100, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: document.body });

        await openPreview(wrapper);

        const shift = previewShift(wrapper);
        // 允许的最右位置是 750 - 12 - 288 = 450，chip 左缘 732 → 必须左移
        expect(shift).toBeLessThan(0);
        expect(chipRect.left + shift + PREVIEW_SIZE.width).toBeLessThanOrEqual(CLIP.right);
    });

    it('intersects every clipping ancestor instead of trusting the nearest one', async () => {
        // 内层滚动容器比外层宽：只看最近的那个会把预览放进外层被裁掉的区域。
        document.body.innerHTML = '';
        const outer = document.createElement('div');
        outer.style.overflow = 'hidden';
        const inner = document.createElement('div');
        inner.style.overflowY = 'auto';
        outer.appendChild(inner);
        document.body.appendChild(outer);

        outer.getBoundingClientRect = () => rect(0, 0, 400, 600);
        inner.getBoundingClientRect = () => rect(0, 0, 750, 600);
        chipRect = rect(380, 100, 18, 18);

        const host = document.createElement('div');
        inner.appendChild(host);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: host });

        await openPreview(wrapper);

        const shift = previewShift(wrapper);
        // 以最窄的外层（400）为准：右缘不能超过 400
        expect(chipRect.left + shift + PREVIEW_SIZE.width).toBeLessThanOrEqual(400);
    });

    it('caps the preview width to the clipping area', async () => {
        // 兼底：窗口很窄时预览不能比可用区域还宽
        chipRect = rect(100, 100, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: document.body });

        await openPreview(wrapper);

        const style = wrapper.get('[role="tooltip"]').attributes('style') ?? '';
        const maxWidth = Number(/max-width:\s*([\d.]+)px/.exec(style)?.[1] ?? '0');
        expect(maxWidth).toBeGreaterThan(0);
        expect(maxWidth).toBeLessThanOrEqual(CLIP.width);
    });

    it('clamps with the measured preview width instead of a hardcoded constant', async () => {
        // 夹取必须用实测宽度：写死常量会和 CSS 脱钩，改样式后夹取静默失效。
        // 这里把预览量成 400（而不是 CSS 的 288），验证夹取真的看了实测值。
        previewSize = { width: 400, height: 96 };
        chipRect = rect(600, 100, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: document.body });

        await openPreview(wrapper);

        const shift = previewShift(wrapper);
        // 右缘只能到 750 - 12 = 738 → 左缘 738 - 400 = 338
        expect(chipRect.left + shift).toBe(338);
        expect(chipRect.left + shift + previewSize.width).toBeLessThanOrEqual(CLIP.right);
    });

    it('defers clamping instead of guessing when the preview has no measured size yet', async () => {
        // 首帧拿不到尺寸时不猜宽度：先不夹，等 ResizeObserver 量到再重算。
        // （猜一个常量正是之前“还是超出”的根源。）
        chipRect = rect(600, 100, 18, 18);
        previewMeasuresZero = true;
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: document.body });

        await openPreview(wrapper);

        expect(previewShift(wrapper)).toBe(0);
        expect(wrapper.get('[role="tooltip"]').attributes('style')).not.toContain('max-width');
    });

    it('shrinks the preview when the clipping area is narrower than the card', async () => {
        // 会话面板比卡片窄：max-width 必须跟着裁剪区收窄，否则右侧被裁掉。
        clipRect = rect(0, 0, 240, 600);
        chipRect = rect(180, 100, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: document.body });

        await openPreview(wrapper);

        const style = wrapper.get('[role="tooltip"]').attributes('style') ?? '';
        const maxWidth = Number(/max-width:\s*([\d.]+)px/.exec(style)?.[1] ?? '0');
        expect(maxWidth).toBeGreaterThan(0);
        expect(maxWidth).toBeLessThan(PREVIEW_SIZE.width);

        const shift = previewShift(wrapper);
        expect(chipRect.left + shift + maxWidth).toBeLessThanOrEqual(240);
    });

    it('flips the preview above when there is no room below', async () => {
        // 贴近裁剪区底部，下方只剩 8px
        chipRect = rect(100, 574, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: document.body });

        await openPreview(wrapper);

        expect(wrapper.get('[role="tooltip"]').classes()).toContain(
            'web-search-citation__preview--above'
        );
    });

    /**
     * 创建一条带正文列约束的宿主链：
     * body（全宽 0..750，overflow hidden）> column（正文列）。
     */
    function mountInsideColumn(column: DOMRect) {
        columnRect = column;
        const host = document.createElement('div');
        host.dataset.contentColumn = 'true';
        document.body.appendChild(host);
        return { host, wrapper: mount(WebSearchCitation, { props: { source }, attachTo: host }) };
    }

    it('keeps the preview inside the content column instead of the panel edge', async () => {
        // 真实布局：会话容器是全宽的 0..750（左根裁剪祖先），
        // 但会话面板左右各留 40px 内边距，正文列右边在 710。
        // 只按裁剪区夹取，预览右缘会落在 738 —— 正文右侧的留白里，
        // 卡片是近白色、页面也是近白色，看上去就是「字跑出了正文」。
        chipRect = rect(519, 100, 18, 18); // 实测里最靠右的那个引用
        const { wrapper } = mountInsideColumn(rect(40, 0, 670, 600));

        await openPreview(wrapper);

        const shift = previewShift(wrapper);
        // 右缘必须停在正文列边界（710）内侧 VIEWPORT_MARGIN 处，而不是裁剪区的 738
        expect(chipRect.left + shift + PREVIEW_SIZE.width).toBe(710 - 12);
        expect(shift).toBeLessThan(0);
    });

    it('shrinks the preview to the content column when the column is narrow', async () => {
        // 正文列比卡片窄（引用在引文 / 表格单元格里）：宽度收窄到列内，不越过列边界。
        chipRect = rect(150, 100, 18, 18);
        const { wrapper } = mountInsideColumn(rect(40, 0, 200, 600));

        await openPreview(wrapper);

        const style = wrapper.get('[role="tooltip"]').attributes('style') ?? '';
        const maxWidth = Number(/max-width:\s*([\d.]+)px/.exec(style)?.[1] ?? '0');
        const shift = previewShift(wrapper);

        expect(maxWidth).toBe(176);
        expect(chipRect.left + shift + maxWidth).toBe(240 - 12);
    });
});
