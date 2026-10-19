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
    /** 引用标记上的标题最多显示几个字。 */
    const CITATION_LABEL_MAX_CHARS = 8;
    /** 预览与视口/面板边缘的最小间距。正文列边界不再叠加它 —— 列自己已有内边距。 */
    const VIEWPORT_MARGIN = 12;
    /** 预览的宽度下限：可用空间再小也要保持可读。 */
    const MIN_PREVIEW_WIDTH = 120;

    interface Props {
        source: WebSearchSource;
        index?: number;
    }

    const props = defineProps<Props>();

    const rootRef = ref<HTMLElement | null>(null);
    const previewRef = ref<HTMLElement | null>(null);
    const previewOpen = ref(false);
    /** 下方空间不够时把预览翻到 chip 上方，避免被会话面板裁掉。 */
    const previewAbove = ref(false);
    /** 预览相对于 chip 左边缘的水平偏移，用于把它夹在视口内。 */
    const previewShift = ref(0);
    /** 预览允许的最大宽度，按裁剪区实测宽度下发。 */
    const previewMaxWidth = ref<number | null>(null);
    /**
     * 预览的实测自然尺寸。
     *
     * 夹取必须知道预览有多宽，但写死常量会和 CSS 脱钩：
     * 改了样式忘了改常量，夹取会静默失效（用户看到的就是“还是超出”）。
     * 所以打开时先量一次：那一刻 `max-width` 还没下发，量到的就是 CSS 给的自然尺寸。
     */
    let previewNaturalSize: { width: number; height: number } | null = null;
    let previewResizeObserver: ResizeObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const hostname = computed(() => webSearchHostname(props.source.url));

    /**
     * 行内标记上显示的文字：网页标题，最多 {@link CITATION_LABEL_MAX_CHARS} 字。
     *
     * 标题为空时退回站点短名，保证标记不会只剩一个图标。
     */
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
     * 算出预览实际可用的矩形。
     *
     * 取**所有**裁剪祖先（以及视口）的交集，而不是最近的那一个：
     * 内层滚动容器往往比外层容器宽，只看内层会把预览放到外层被裁掉的区域里。
     */
    function resolveClipRect(element: HTMLElement): DOMRect {
        let left = 0;
        let top = 0;
        let right = window.innerWidth;
        let bottom = window.innerHeight;

        let node = element.parentElement;
        while (node) {
            const style = getComputedStyle(node);
            // 同时看简写与长写：部分环境不会把 `overflow` 展开成 `overflowX/Y`。
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
     * {@link resolveClipRect} 只能算到会话容器，而它是全宽的（750 的窗口就是 0..750）。
     * 视觉上的边界其实是正文列：会话面板左右各留 40px 内边距，正文列右边缘在 710。
     * 只按裁剪区夹取，预览右边缘会落在 738 —— 正文右侧的留白里。
     * 卡片是近白色、页面也是近白色，用户看不到卡片边界，
     * 只会看到卡片里的字跑到正文右外侧，就是「超出」。
     *
     * 行内内容的往外一层块级祖先就是正文列：预览应当留在这个盒子里。
     * 没有布局宽度的祖先（未完成布局、零宽包装元素）不构成列，继续往上找；
     * 全链都拿不到就返回 null，退回只用裁剪区。
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
     * 两件事：
     * - 垂直：下方放不下就翻到上方；
     * - 水平：`left: 0` 对齐 chip 左边缘，靠边时向内收。
     *
     * 尺寸用**实测值**（见 {@link previewNaturalSize}），不再写死常量。
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

        /**
         * 先确定左边缘，再算可用宽度。
         *
         * 之前先按「裁剪区全宽」算 maxWidth，再用它算 maxLeft，
         * 结果是宽度已经占满整个区，左边就无处可收了 —— 预览仍然溢出。
         * 正确顺序：先夹左边缘，再拿剩下的空间定宽度。
         *
         * 横向边界取「裁剪区」与「正文列」的交集，并统一留出 {@link VIEWPORT_MARGIN}：
         * 裁剪区防止被裁掉，正文列保证不越过用户视觉上的边界；
         * 贴着边界放（不留间隙）看上去就像卡片被切了，必须留白。
         */
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

    /**
     * 预览尺寸变化（首帧完成布局、可用宽度收窄、内容回流）后重算位置。
     *
     * 重算用的始终是缓存的自然尺寸，所以同样的输入得到同样的输出，不会自激振荡。
     */
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

    /**
     * 窗口/面板尺寸变化时重新安置。
     *
     * 会话窗会按内容自适应高度（会话加载完还会再动一次），
     * 如果预览在尺寸稳定前就算好了位置，夹取参数就是旧的。
     */
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

    /** 悬停要等一拍，指针路过不该弹出预览。 */
    function onPointerEnter(event: PointerEvent): void {
        if (event.pointerType === 'mouse') schedule(true, PREVIEW_DELAY_MS);
    }

    function onPointerLeave(): void {
        schedule(false, LEAVE_DELAY_MS);
    }

    /** 预览区自己也是悬停区，从 chip 移过去时不能立刻关闭。 */
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
