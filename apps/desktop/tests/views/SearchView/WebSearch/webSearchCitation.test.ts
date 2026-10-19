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
/** 视口尺寸（jsdom 默认 1024x768，用例按需改）。 */
let viewport = { width: 750, height: 600 };

/** 实现读的是 `window.innerWidth/innerHeight`，必须同步 stub。 */
function applyViewportStub(): void {
    Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: viewport.width,
    });
    Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: viewport.height,
    });
}

let chipRect = rect(100, 100, 18, 18);
/** 正文列的矩形（带 `data-content-column` 的容器），null 表示这个用例没有正文列约束。 */
let columnRect: DOMRect | null = null;
let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
/**
 * 预览在首帧的真实行为：元素已经进 DOM 但还没完成布局，
 * `getBoundingClientRect()` 返回 0。
 */
let previewMeasuresZero = false;

/**
 * 统一接管矩形测量。
 *
 * 预览通过 Teleport 挂到 body，定位只依赖 chip 矩形 + 视口 + 正文列，
 * 不再受任何裁剪祖先影响。
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
            return rect(0, 0, viewport.width, viewport.height);
        }
        return originalGetBoundingClientRect.call(this);
    };
}

async function openPreview(wrapper: ReturnType<typeof mount>): Promise<void> {
    applyViewportStub();
    await wrapper.get('.web-search-citation').trigger('pointerenter', { pointerType: 'mouse' });
    vi.advanceTimersByTime(400);
    // 打开后 watcher 里还有 await nextTick()，要清空微任务队列才能等到布局计算
    await flushPromises();
}

/** 预览已 Teleport 到 body，必须从 document 里查。 */
function previewEl(): HTMLElement | null {
    return document.querySelector('[role="tooltip"]');
}

function previewStyleText(): string {
    return previewEl()?.getAttribute('style') ?? '';
}

function previewMetric(name: 'left' | 'top' | 'max-width' | 'max-height'): number {
    const match = new RegExp(`${name}:\\s*(-?[\\d.]+)px`).exec(previewStyleText());
    return Number(match?.[1] ?? '0');
}

describe('WebSearchCitation layout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        viewport = { width: 750, height: 600 };
        columnRect = null;
        previewSize = PREVIEW_SIZE;
        previewMeasuresZero = false;
        applyViewportStub();
        installRectStubs();
    });

    afterEach(() => {
        vi.useRealTimers();
        HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
        document.body.innerHTML = '';
    });

    it('shows the page title capped at 8 characters on the chip', () => {
        const wrapper = mount(WebSearchCitation, {
            props: {
                source: { ...source, title: 'A very long page title here' },
            },
        });

        expect(wrapper.get('.web-search-citation__label').text()).toBe('A very l…');
    });

    it('keeps a short title as-is', () => {
        const wrapper = mount(WebSearchCitation, {
            props: { source: { ...source, title: 'Short' } },
        });

        expect(wrapper.get('.web-search-citation__label').text()).toBe('Short');
    });

    it('falls back to the site name when the title is missing', () => {
        const wrapper = mount(WebSearchCitation, {
            props: { source: { ...source, title: '' } },
        });

        expect(wrapper.get('.web-search-citation__label').text()).toBe('example');
    });

    it('shows only the favicon on a circular background', () => {
        const wrapper = mount(WebSearchCitation, { props: { source } });

        const chip = wrapper.get('.web-search-citation__chip');
        expect(chip.find('img').exists() || chip.text() === '').toBe(true);
        expect(wrapper.find('.web-search-citation__index').exists()).toBe(false);
    });

    it('renders the preview into body so clipping ancestors cannot cut it', async () => {
        // 这是本轮的核心回归：预览必须脱离会话面板的 overflow 裁剪。
        const panel = document.createElement('div');
        panel.style.overflow = 'hidden';
        document.body.appendChild(panel);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: panel });

        await openPreview(wrapper);

        const preview = previewEl();
        expect(preview).not.toBeNull();
        // 预览不能落在会裁剪的 panel 里
        expect(panel.contains(preview)).toBe(false);
        // 它必须挂在 body 的子树下（Teleport 目标）
        expect(document.body.contains(preview)).toBe(true);
    });

    it('positions the preview with fixed coordinates', async () => {
        chipRect = rect(100, 100, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source } });

        await openPreview(wrapper);

        expect(previewMetric('left')).toBe(100);
        expect(previewMetric('top')).toBe(118 + 8);
    });

    it('pulls the preview back inside the viewport on the right', async () => {
        // chip 贴近视口右缘：预览必须左移，右缘不越界
        chipRect = rect(700, 100, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source } });

        await openPreview(wrapper);

        const left = previewMetric('left');
        expect(left + PREVIEW_SIZE.width).toBeLessThanOrEqual(viewport.width - 12);
        expect(left).toBeLessThan(chipRect.left);
    });

    it('keeps the preview inside the content column instead of the viewport edge', async () => {
        // 正文列比视口窄：卡片右缘不能伸进正文右侧的留白。
        chipRect = rect(519, 100, 18, 18);
        columnRect = rect(40, 0, 670, 600);
        const host = document.createElement('div');
        host.dataset.contentColumn = 'true';
        document.body.appendChild(host);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: host });

        await openPreview(wrapper);

        // 右边界 = min(750-12, 710) - 12 = 698
        expect(previewMetric('left') + PREVIEW_SIZE.width).toBe(698);
    });

    it('shrinks the preview to the content column when the column is narrow', async () => {
        chipRect = rect(150, 100, 18, 18);
        columnRect = rect(40, 0, 200, 600);
        const host = document.createElement('div');
        host.dataset.contentColumn = 'true';
        document.body.appendChild(host);
        const wrapper = mount(WebSearchCitation, { props: { source }, attachTo: host });

        await openPreview(wrapper);

        // 左边界 = max(12, 40) = 40；右边界 = min(738, 240) - 12 = 228
        expect(previewMetric('max-width')).toBe(228 - 40);
    });

    it('caps the preview height when neither side has enough room', async () => {
        // 窗口很矮：上下都放不下时必须收窄高度，否则卡片底部被视口切掉。
        viewport = { width: 750, height: 160 };
        chipRect = rect(100, 70, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source } });

        await openPreview(wrapper);

        const maxHeight = previewMetric('max-height');
        expect(maxHeight).toBeGreaterThan(0);
        expect(maxHeight).toBeLessThan(PREVIEW_SIZE.height);
        // 卡片底部不超出视口
        expect(previewMetric('top') + maxHeight).toBeLessThanOrEqual(160);
    });

    it('flips the preview above when there is no room below', async () => {
        // 贴近视口底部，下方只剩 8px
        viewport = { width: 750, height: 600 };
        chipRect = rect(100, 574, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source } });

        await openPreview(wrapper);

        expect(previewEl()?.classList.contains('web-search-citation__preview--above')).toBe(true);
        // 翻到上方后底部不越界
        const top = previewMetric('top');
        const height = Math.min(PREVIEW_SIZE.height, previewMetric('max-height'));
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top + height).toBeLessThanOrEqual(chipRect.top);
    });

    it('defers clamping instead of guessing when the preview has no measured size yet', async () => {
        // 首帧拿不到尺寸时不猜宽度，等 ResizeObserver 量到再算。
        chipRect = rect(600, 100, 18, 18);
        previewMeasuresZero = true;
        const wrapper = mount(WebSearchCitation, { props: { source } });

        await openPreview(wrapper);

        expect(previewStyleText()).not.toContain('max-width');
    });

    it('clamps with the measured preview width instead of a hardcoded constant', async () => {
        // 夹取必须用实测宽度：写死常量会和 CSS 脱钩。
        previewSize = { width: 400, height: 96 };
        chipRect = rect(600, 100, 18, 18);
        const wrapper = mount(WebSearchCitation, { props: { source } });

        await openPreview(wrapper);

        const left = previewMetric('left');
        expect(left + previewSize.width).toBeLessThanOrEqual(viewport.width - 12);
    });
});
