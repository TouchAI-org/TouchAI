<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->
<template>
    <span
        ref="rootRef"
        class="web-search-citation"
        data-slot="web-search-citation"
        @pointerenter="onPointerEnter"
        @pointerleave="onPointerLeave"
    >
        <a
            :href="source.url"
            target="_blank"
            rel="noreferrer"
            :aria-label="`${source.title}, ${hostname}`"
            class="web-search-citation__chip"
            @focus="onFocus"
            @blur="onBlur"
        >
            <SourceFavicon :source="source" :size="14" />
            <span class="web-search-citation__label">{{ citationLabel }}</span>
        </a>

        <Transition name="web-search-citation-pop">
            <span
                v-if="previewOpen"
                ref="previewRef"
                role="tooltip"
                :class="
                    previewAbove
                        ? 'web-search-citation__preview web-search-citation__preview--above'
                        : 'web-search-citation__preview'
                "
                :style="previewStyle"
                @pointerenter="cancelLeaving"
                @pointerleave="scheduleClose"
            >
                <a
                    :href="source.url"
                    target="_blank"
                    rel="noreferrer"
                    tabindex="-1"
                    class="web-search-citation__card"
                >
                    <span class="web-search-citation__card-head">
                        <SourceFavicon :source="source" :size="18" />
                        <span class="web-search-citation__card-host">{{ hostname }}</span>
                    </span>
                    <span class="web-search-citation__card-title">{{ source.title }}</span>
                    <span v-if="source.snippet" class="web-search-citation__card-snippet">
                        {{ source.snippet }}
                    </span>
                </a>
            </span>
        </Transition>
    </span>
</template>

<script setup lang="ts">
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import {
        webSearchHostname,
        webSearchSiteName,
        type WebSearchSource,
    } from '@/services/BuiltInToolService/tools/webSearch/sources';
    import { truncateText } from '@/utils/text';

    import SourceFavicon from './SourceFavicon.vue';

    const PREVIEW_DELAY_MS = 300;
    const LEAVE_DELAY_MS = 150;
    /** 行内标记上最多显示几个字。 */
    const CITATION_LABEL_MAX_CHARS = 8;
    const VIEWPORT_MARGIN = 12;
    const MIN_PREVIEW_WIDTH = 120;

    interface Props {
        source: WebSearchSource;
        index?: number;
    }

    const props = defineProps<Props>();

    const rootRef = ref<HTMLElement | null>(null);
    const previewRef = ref<HTMLElement | null>(null);
    const previewOpen = ref(false);
    /** 下方放不下时翻到 chip 上方。 */
    const previewAbove = ref(false);
    const previewShift = ref(0);
    const previewMaxWidth = ref<number | null>(null);
    /**
     * 预览的实测自然尺寸。
     *
     * 打开时量一次：那一刻 `max-width` 还没下发，量到的就是 CSS 给的自然尺寸。
     * 写死常量会和 CSS 脱钩，改样式后夹取会静默失效。
     */
    let previewNaturalSize: { width: number; height: number } | null = null;
    let previewResizeObserver: ResizeObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const hostname = computed(() => webSearchHostname(props.source.url));

    /** 标题为空时退回站点短名，保证标记不会只剩一个图标。 */
    const citationLabel = computed(() => {
        const title = props.source.title?.trim();
        const base = title || webSearchSiteName(props.source.url);
        return truncateText(base, CITATION_LABEL_MAX_CHARS, '…');
    });

    const previewStyle = computed(() => ({
        marginLeft: `${previewShift.value}px`,
        maxWidth: previewMaxWidth.value ? `${previewMaxWidth.value}px` : undefined,
    }));

    /**
     * 取所有裁剪祖先与视口的交集，而不是最近的那一个：
     * 内层滚动容器往往比外层宽，只看内层会把预览放到外层被裁掉的区域里。
     */
    function resolveClipRect(element: HTMLElement): DOMRect {
        let left = 0;
        let top = 0;
        let right = window.innerWidth;
        let bottom = window.innerHeight;

        let node = element.parentElement;
        while (node) {
            const style = getComputedStyle(node);
            // 部分环境不会把 `overflow` 展开成 `overflowX/Y`，两者都看。
            const clips = [style.overflow, style.overflowX, style.overflowY].some((value) =>
                /(auto|scroll|hidden)/.test(value ?? '')
            );
            if (clips) {
                const rect = node.getBoundingClientRect();
                left = Math.max(left, rect.left);
                top = Math.max(top, rect.top);
                right = Math.min(right, rect.right);
                bottom = Math.min(bottom, rect.bottom);
            }
            node = node.parentElement;
        }

        return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
    }

    /**
     * 找「正文列」的横向边界。
     *
     * 裁剪区只能算到全宽的会话容器，而视觉边界是正文列：
     * 面板左右各留 40px 内边距，只按裁剪区夹取，预览会落进正文右侧的留白里。
     * 卡片与页面都是近白色，用户看不到卡片边界，只会看到字跑到正文外侧。
     *
     * 零宽祖先（未完成布局、包装元素）不构成列，继续往上找。
     */
    function resolveContentColumn(element: HTMLElement): { left: number; right: number } | null {
        let node = element.parentElement;
        while (node) {
            const display = getComputedStyle(node).display ?? '';
            const isBlockLike =
                !display.startsWith('inline') && display !== 'contents' && display !== 'none';
            if (isBlockLike) {
                const rect = node.getBoundingClientRect();
                if (rect.width > 0) {
                    return { left: rect.left, right: rect.right };
                }
            }
            node = node.parentElement;
        }

        return null;
    }

    /** 读预览的自然尺寸；没完成布局（拿不到宽高）时返回 null。 */
    function readPreviewSize(): { width: number; height: number } | null {
        const preview = previewRef.value;
        if (!preview) {
            return null;
        }
        const rect = preview.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
            ? { width: rect.width, height: rect.height }
            : null;
    }

    /**
     * 把预览放到可见区域内的可读位置。
     *
     * 尺寸用实测值：写死常量会和 CSS 脱钩，改样式后夹取会静默失效。
     */
    function placePreview(): void {
        const root = rootRef.value;
        if (!root || !previewRef.value || typeof window === 'undefined') {
            return;
        }

        // 拿不到实测尺寸就不猜：宁可不夹，等实测到了由 ResizeObserver 再重算。
        const size = previewNaturalSize ?? readPreviewSize();
        if (!size) {
            return;
        }
        previewNaturalSize = size;

        const chipRect = root.getBoundingClientRect();
        const clip = resolveClipRect(root);
        const column = resolveContentColumn(root);

        const spaceBelow = clip.bottom - chipRect.bottom - VIEWPORT_MARGIN;
        const spaceAbove = chipRect.top - clip.top - VIEWPORT_MARGIN;
        previewAbove.value = spaceBelow < size.height && spaceAbove > spaceBelow;

        // 先夹左边缘再定宽度：反过来会让宽度占满整个区，左边无处可收。
        // 边界取裁剪区与正文列的交集，并统一留白 —— 贴着边界放看着像被切了。
        const limitLeft =
            Math.max(clip.left, column?.left ?? Number.NEGATIVE_INFINITY) + VIEWPORT_MARGIN;
        const limitRight =
            Math.min(clip.right, column?.right ?? Number.POSITIVE_INFINITY) - VIEWPORT_MARGIN;
        const maxLeft = Math.max(limitLeft, limitRight - size.width);
        const left = Math.min(Math.max(chipRect.left, limitLeft), maxLeft);
        const availableWidth = Math.max(MIN_PREVIEW_WIDTH, limitRight - left);

        previewShift.value = left - chipRect.left;
        previewMaxWidth.value = availableWidth;
    }

    /** 尺寸变化（首帧布局、可用宽度收窄、内容回流）后重算位置。 */
    function observePreviewSize(): void {
        previewResizeObserver?.disconnect();
        previewResizeObserver = null;

        const preview = previewRef.value;
        if (!preview || typeof ResizeObserver === 'undefined') {
            return;
        }

        previewResizeObserver = new ResizeObserver(() => {
            if (!previewOpen.value) {
                return;
            }
            previewNaturalSize ??= readPreviewSize();
            if (previewNaturalSize) {
                placePreview();
            }
        });
        previewResizeObserver.observe(preview);
    }

    function releasePreview(): void {
        previewShift.value = 0;
        previewMaxWidth.value = null;
        previewAbove.value = false;
        previewNaturalSize = null;
        previewResizeObserver?.disconnect();
        previewResizeObserver = null;
    }

    watch(previewOpen, async (open) => {
        if (!open) {
            releasePreview();
            return;
        }
        await nextTick();
        // 此刻 `max-width` 还没下发，量到的就是 CSS 给的自然尺寸
        previewNaturalSize = readPreviewSize();
        placePreview();
        observePreviewSize();
    });

    /** 会话窗会按内容自适应高度，尺寸稳定前算出的位置是旧的。 */
    function handleViewportResize(): void {
        if (previewOpen.value) {
            placePreview();
        }
    }

    function clearTimer(): void {
        if (timer) {
            clearTimeout(timer);
            timer = undefined;
        }
    }

    function schedule(next: boolean, delay: number): void {
        clearTimer();
        timer = setTimeout(() => {
            previewOpen.value = next;
        }, delay);
    }

    /** 指针路过不该弹出预览。 */
    function onPointerEnter(event: PointerEvent): void {
        if (event.pointerType === 'mouse') schedule(true, PREVIEW_DELAY_MS);
    }

    function onPointerLeave(): void {
        schedule(false, LEAVE_DELAY_MS);
    }

    /** 预览区也是悬停区，从 chip 移过去时不能立刻关闭。 */
    function cancelLeaving(): void {
        clearTimer();
    }

    function scheduleClose(): void {
        schedule(false, LEAVE_DELAY_MS);
    }

    /** 只有键盘焦点才展开；鼠标点击本来就要跳转。 */
    function onFocus(event: FocusEvent): void {
        if ((event.target as HTMLElement | null)?.matches(':focus-visible')) {
            schedule(true, 0);
        }
    }

    function onBlur(): void {
        schedule(false, 0);
    }

    onBeforeUnmount(() => {
        clearTimer();
        previewResizeObserver?.disconnect();
        previewResizeObserver = null;
        window.removeEventListener('resize', handleViewportResize);
    });

    onMounted(() => {
        window.addEventListener('resize', handleViewportResize);
    });
</script>

<style scoped>
    .web-search-citation {
        position: relative;
        display: inline-flex;
        /*
         * `middle` 把元素垂直中心对齐到父行盒的 baseline + x-height/2。
         * 正文是 CJK 衬线字（字号 15px / 行高 30.75px），字面重心比
         * x-height 高，实测 chip 中心比行盒中心低 2.8px。
         * 用 em 向上补，字号变化时同比例跟随。
         */
        top: -0.19em;
        vertical-align: middle;

        /* 与来源卡片用同一个色调：比页面背景略深一点即可，不要太重。 */
        --ws-chip-bg: #f2efec;
        --ws-chip-hover-bg: #ffffff;
        --ws-muted: var(--color-primary-400, #968b7d);
        --ws-ring: rgba(150, 139, 125, 0.22);
    }

    .web-search-citation__chip {
        display: inline-flex;
        /* 行内标记：图标 + 短标题，标题超长时省略。 */
        max-width: 11rem;
        height: 18px;
        align-items: center;
        gap: 3px;
        padding: 0 6px 0 2px;
        border-radius: 999px;
        background: var(--ws-chip-bg);
        color: var(--ws-muted);
        font-size: 11px;
        font-weight: 500;
        line-height: 1;
        text-decoration: none;
        transition:
            background-color 160ms ease,
            color 160ms ease,
            box-shadow 160ms ease,
            scale 160ms ease;
    }

    .web-search-citation__label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .web-search-citation__chip:hover,
    .web-search-citation__chip:focus-visible {
        background: var(--ws-chip-hover-bg);
        color: var(--color-primary-700, #4a4039);
        box-shadow:
            0 0 0 1px var(--ws-ring),
            0 1px 3px -1px rgba(107, 95, 84, 0.2);
        scale: 1.04;
        outline: none;
    }

    .web-search-citation__chip:focus-visible {
        outline: 2px solid var(--color-primary-300, #b8afa5);
        outline-offset: 1px;
    }

    .web-search-citation__preview {
        position: absolute;
        /*
         * 铺认铺在 chip 下方，并锚定到 chip 左边缘而不是居中：
         * 行内引用落在窄正文列里，居中的 288px 预览会直接溢出容器左侧。
         */
        top: 100%;
        left: 0;
        z-index: 50;
        display: block;
        width: 288px;
        max-width: calc(100vw - 24px);
        padding-top: 8px;
        /* chip 在 nowrap 行内，预览需要自己恢复换行。 */
        white-space: normal;
        transform-origin: top left;
    }

    /* 下方空间不够时翻到上方；会话面板会裁掉溢出内容。 */
    .web-search-citation__preview--above {
        top: auto;
        bottom: 100%;
        padding-top: 0;
        padding-bottom: 8px;
        transform-origin: bottom left;
    }

    .web-search-citation__card {
        display: block;
        padding: 12px;
        border-radius: 16px;
        background: #ffffff;
        color: inherit;
        text-align: left;
        text-decoration: none;
        /*
         * 两层阴影，缺一不可：
         * - 亮一层只带 12px 下偏移，左右两侧几乎看不到收边，卡片边缘会显得是“被切掉”的；
         * - 补一层小范围、小偏移的环境阴影，让四条边都浮起来。
         */
        box-shadow:
            0 12px 28px -10px rgba(74, 64, 57, 0.26),
            0 2px 8px -2px rgba(74, 64, 57, 0.16),
            0 0 0 1px var(--ws-ring);
    }

    .web-search-citation__card-head {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .web-search-citation__card-host {
        overflow: hidden;
        color: var(--ws-muted);
        font-size: 12px;
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .web-search-citation__card-title {
        display: -webkit-box;
        overflow: hidden;
        margin-top: 6px;
        color: var(--color-primary-700, #4a4039);
        font-size: 13.5px;
        font-weight: 600;
        line-height: 18px;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
    }

    .web-search-citation__card-snippet {
        display: -webkit-box;
        overflow: hidden;
        margin-top: 4px;
        color: var(--ws-muted);
        font-size: 12.5px;
        font-weight: 500;
        line-height: 17px;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
    }

    .web-search-citation-pop-enter-active,
    .web-search-citation-pop-leave-active {
        transition: opacity 180ms ease;
    }

    .web-search-citation-pop-enter-from,
    .web-search-citation-pop-leave-to {
        opacity: 0;
    }

    @media (prefers-reduced-motion: reduce) {
        .web-search-citation-pop-enter-active,
        .web-search-citation-pop-leave-active,
        .web-search-citation__chip {
            transition: none;
        }
    }
</style>
