<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->
<template>
    <div class="web-search-sources paragraph-node touchai-markdown touchai-markdown--default">
        <!--
          顶部沿用内置工具原本的日志行：verb + 语义内容 + 耗时。
          这里只负责在它下面追加可收缩的来源卡片，不改动任何既有文案。
        -->
        <button
            type="button"
            class="web-search-sources__trigger"
            :aria-expanded="isOpen"
            @click="toggle"
        >
            <span class="tool-call-log-line">
                <span class="tool-call-log-verb">{{ verbText }}</span>
                <span
                    v-if="displaySummary"
                    class="tool-call-log-content"
                    data-no-i18n="isSummaryPayload ? 'true' : undefined"
                    :translate="isSummaryPayload ? 'no' : undefined"
                >
                    {{ ` ${displaySummary}` }}
                </span>
                <span
                    v-if="providerName"
                    class="web-search-sources__engine"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ providerName }}
                </span>
                <span
                    v-if="durationText"
                    class="tool-call-log-duration"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ ` (${durationText})` }}
                </span>
            </span>
        </button>

        <MotionCollapse :open="isOpen && (sources.length > 0 || searching)">
            <!--
              横向滚动轨道，不再换行堆成多行。
              两侧用渐变色覆盖层提示还有内容（不用 mask：遮罩会把滚动条一起裁掉）。
            -->
            <div class="web-search-sources__viewport">
                <ol
                    ref="railRef"
                    :class="
                        dragging
                            ? 'web-search-sources__rail web-search-sources__rail--dragging'
                            : 'web-search-sources__rail'
                    "
                    data-slot="web-search-sources"
                    :style="railStyle"
                    @scroll.passive="syncFade"
                    @wheel="onWheel"
                    @pointerdown="onPointerDown"
                    @pointermove="onPointerMove"
                    @pointerup="onPointerUp"
                    @pointercancel="onPointerUp"
                    @click.capture="suppressClickAfterDrag"
                >
                    <!-- 搜索进行中以骨架卡片占位，避免内容到位前轨道是空的 -->
                    <li
                        v-for="skeletonIndex in skeletonCount"
                        :key="`skeleton-${skeletonIndex}`"
                        aria-hidden="true"
                        class="web-search-sources__cell"
                    >
                        <span
                            class="web-search-sources__card web-search-sources__card--skeleton"
                            data-slot="web-search-skeleton"
                            :style="{ animationDelay: `${(skeletonIndex - 1) * 0.12}s` }"
                        >
                            <span class="web-search-sources__skeleton-lines">
                                <span class="web-search-sources__skeleton-bar w-[88%]"></span>
                                <span class="web-search-sources__skeleton-bar w-[58%]"></span>
                            </span>
                            <span class="web-search-sources__card-meta">
                                <span
                                    class="web-search-sources__skeleton-bar size-4 rounded-full"
                                ></span>
                                <span class="web-search-sources__skeleton-bar h-2 w-12"></span>
                            </span>
                            <span class="web-search-sources__skeleton-shine"></span>
                        </span>
                    </li>

                    <li
                        v-for="(source, index) in sources"
                        :key="source.id"
                        class="web-search-sources__cell"
                    >
                        <a
                            class="web-search-sources__card"
                            data-slot="web-search-source"
                            :href="source.url"
                            target="_blank"
                            rel="noreferrer"
                            :title="source.title"
                        >
                            <span class="web-search-sources__card-title">{{ source.title }}</span>
                            <span class="web-search-sources__card-meta">
                                <SourceFavicon :source="source" :size="16" />
                                <span class="web-search-sources__card-site">
                                    {{ siteNameOf(source) }}
                                </span>
                                <span class="web-search-sources__card-index">{{ index + 1 }}</span>
                            </span>
                        </a>
                    </li>
                </ol>

                <!-- 覆盖层只做视觉提示，不拦截指针，否则会把滚轮/拖拽吞掉。 -->
                <span
                    v-if="fadeStart > 0"
                    aria-hidden="true"
                    class="web-search-sources__fade web-search-sources__fade--start"
                    :style="{ width: `${fadeStart}px` }"
                ></span>
                <span
                    v-if="fadeEnd > 0"
                    aria-hidden="true"
                    class="web-search-sources__fade web-search-sources__fade--end"
                    :style="{ width: `${fadeEnd}px` }"
                ></span>
            </div>
        </MotionCollapse>
    </div>
</template>

<script setup lang="ts">
    import MotionCollapse from '@components/MotionCollapse.vue';
    import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

    import {
        webSearchHostname,
        type WebSearchSource,
    } from '@/services/BuiltInToolService/tools/webSearch/sources';
    import SourceFavicon from '@/views/SearchView/components/WebSearch/SourceFavicon.vue';

    const FADE_WIDTH = 40;
    const SKELETON_COUNT = 4;
    /** 一格滚轮通常 100～120px，减半后跟一张卡（176px）的步进相当。 */
    const WHEEL_DAMPING = 0.5;
    /** 每帧消掉剩余距离的比例；0.25 大约 10 帧收尾。 */
    const SCROLL_EASING = 0.25;
    /**
     * `requestAnimationFrame` 在窗口被遮挡时会被节流甚至暂停，
     * 只靠它收尾会把轨道停在离目标一两像素的地方，所以停手这么久就直接落到目标。
     */
    const SCROLL_SETTLE_MS = 400;
    interface Props {
        sources: WebSearchSource[];
        verbText: string;
        summaryText: string;
        durationText?: string | null;
        providerName?: string | null;
        /** summary 来自工具载荷时不应被 i18n 翻译。 */
        isSummaryPayload?: boolean;
        searching?: boolean;
        defaultOpen?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        durationText: null,
        providerName: null,
        isSummaryPayload: false,
        searching: false,
        defaultOpen: true,
    });

    const isOpen = ref(props.defaultOpen);
    const railRef = ref<HTMLElement | null>(null);
    /** 0 表示已到边，不需要渐隐。 */
    const fadeStart = ref(0);
    const fadeEnd = ref(0);
    const dragging = ref(false);
    let resizeObserver: ResizeObserver | undefined;
    let dragPointerId: number | null = null;
    let dragStartX = 0;
    let dragStartScroll = 0;
    let dragMoved = false;
    let scrollTarget: number | null = null;
    let scrollFrame: number | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    const sourceCount = computed(() => props.sources.length);

    const showSkeletons = computed(() => props.searching && props.sources.length === 0);
    const skeletonCount = computed(() => (showSkeletons.value ? SKELETON_COUNT : 0));

    /**
     * 语义 target 是 `<query> · <engine>`，那个后缀在会话预览等处也用，
     * 所以不改它本身，只在本卡片里去掉尾部，避免与标签重复。
     */
    const displaySummary = computed(() => {
        const summary = props.summaryText?.trim() ?? '';
        const engine = props.providerName?.trim();
        if (!summary) return '';
        if (!engine) return summary;

        const suffix = ` · ${engine}`;
        return summary.endsWith(suffix) ? summary.slice(0, -suffix.length).trim() : summary;
    });

    const railStyle = computed(() => ({
        '--ws-fade-start': `${fadeStart.value}px`,
        '--ws-fade-end': `${fadeEnd.value}px`,
    }));
    /**
     * 渐隐宽度跟「实际被藏住的像素量」走，而不是固定 40px：
     * 卡片几乎贴着轨道左边缘，只要残留几像素滚动，固定宽度的渐隐
     * 就会把整张首卡抹掉。
     */
    function syncFade(): void {
        const rail = railRef.value;
        if (!rail) {
            return;
        }

        const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
        const scrolled = Math.min(Math.max(rail.scrollLeft, 0), maxScroll);

        fadeStart.value = Math.min(FADE_WIDTH, scrolled);
        fadeEnd.value = Math.min(FADE_WIDTH, maxScroll - scrolled);
    }

    function siteNameOf(source: WebSearchSource): string {
        // 显示完整域名比折叠成二级域更好认（news.google.com ≠ google）。
        return source.siteName?.trim() || webSearchHostname(source.url);
    }

    /** 立即落到目标位置并收尾。 */
    function finishScroll(): void {
        const rail = railRef.value;
        if (rail && scrollTarget !== null) {
            rail.scrollLeft = scrollTarget;
        }

        scrollTarget = null;
        if (scrollFrame !== null) {
            cancelAnimationFrame(scrollFrame);
            scrollFrame = null;
        }
        if (settleTimer !== null) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }
        syncFade();
    }

    /** 推进一帧缓动；到位后停在目标上。 */
    function stepScroll(): void {
        const rail = railRef.value;
        if (!rail || scrollTarget === null) {
            scrollFrame = null;
            return;
        }

        const remaining = scrollTarget - rail.scrollLeft;
        if (Math.abs(remaining) < 0.5) {
            finishScroll();
            return;
        }

        rail.scrollLeft += remaining * SCROLL_EASING;
        syncFade();
        scrollFrame = requestAnimationFrame(stepScroll);
    }

    function cancelScrollAnimation(): void {
        scrollTarget = null;
        if (scrollFrame !== null) {
            cancelAnimationFrame(scrollFrame);
            scrollFrame = null;
        }
        if (settleTimer !== null) {
            clearTimeout(settleTimer);
            settleTimer = null;
        }
    }

    function startScrollAnimation(): void {
        if (scrollFrame === null) {
            scrollFrame = requestAnimationFrame(stepScroll);
        }

        // 停手后无论如何都落到位，不依赖 rAF 是否被节流。
        if (settleTimer !== null) {
            clearTimeout(settleTimer);
        }
        settleTimer = setTimeout(finishScroll, SCROLL_SETTLE_MS);
    }

    /**
     * 把竖向滚轮转成横向滚动。
     *
     * 轨道没有竖向可滚空间，不转化的话滚轮会直接穿透给外层会话。
     * `deltaX`（触控板/Shift+滚轮）保持原生行为且不额外阻尼。
     */
    function onWheel(event: WheelEvent): void {
        const rail = railRef.value;
        if (!rail || event.deltaX !== 0) {
            return;
        }

        const maxScroll = rail.scrollWidth - rail.clientWidth;
        if (maxScroll <= 0) {
            return;
        }

        // 以未完成动画的目标为基准累加，连续滚动时不会互相打断。
        const base = scrollTarget ?? rail.scrollLeft;
        // 先夹取再判断：最后一档往往越过末端，直接 return 会永远差几十像素到不了尽头。
        const next = Math.min(Math.max(base + event.deltaY * WHEEL_DAMPING, 0), maxScroll);
        if (next === base) {
            return;
        }

        event.preventDefault();
        scrollTarget = next;
        startScrollAnimation();
    }

    function onPointerDown(event: PointerEvent): void {
        const rail = railRef.value;
        if (!rail || event.pointerType !== 'mouse' || event.button !== 0) {
            return;
        }

        // 手动拖拽优先级高于滚轮缓动
        cancelScrollAnimation();
        dragPointerId = event.pointerId;
        dragStartX = event.clientX;
        dragStartScroll = rail.scrollLeft;
        dragMoved = false;
    }

    function onPointerMove(event: PointerEvent): void {
        const rail = railRef.value;
        if (!rail || dragPointerId !== event.pointerId) {
            return;
        }

        const delta = event.clientX - dragStartX;
        if (!dragMoved) {
            // 极小位移属于正常点击
            if (Math.abs(delta) < 4) {
                return;
            }
            dragMoved = true;
            dragging.value = true;
            rail.setPointerCapture(event.pointerId);
        }

        event.preventDefault();
        rail.scrollLeft = dragStartScroll - delta;
        syncFade();
    }

    function onPointerUp(event: PointerEvent): void {
        if (dragPointerId !== event.pointerId) {
            return;
        }

        railRef.value?.releasePointerCapture?.(event.pointerId);
        dragPointerId = null;
        dragging.value = false;
    }

    /** 拖拽结束时抑制一次点击，否则会误打开卡片链接。 */
    function suppressClickAfterDrag(event: MouseEvent): void {
        if (!dragMoved) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        dragMoved = false;
    }

    function toggle(): void {
        if (sourceCount.value === 0) return;
        isOpen.value = !isOpen.value;
    }

    watch(
        () => [sourceCount.value, showSkeletons.value],
        async () => {
            // 内容变化后滚动位置与可滚宽度都会变，等渲染完再重算遮罩。
            await nextTick();
            syncFade();
        }
    );

    watch(isOpen, async (open) => {
        if (!open) return;
        await nextTick();
        syncFade();
    });

    onMounted(() => {
        syncFade();
        // 窗口尺寸变化会改变可见卡片数，遮罩宽度要跟着重算。
        if (typeof ResizeObserver !== 'undefined' && railRef.value) {
            resizeObserver = new ResizeObserver(() => syncFade());
            resizeObserver.observe(railRef.value);
        }
    });

    onBeforeUnmount(() => {
        resizeObserver?.disconnect();
        cancelScrollAnimation();
    });
</script>

<style scoped>
    /*
     * 配色跟随应用的暖调主色（--color-primary-*），
     * 不用冷蓝灰，否则会与周围的中性背景脱节。
     */
    .web-search-sources {
        /*
         * 卡片底色：比页面背景只深一档，能看出是卡片即可。
         * （primary-100 太重、primary-50 又几乎融进背景。）
         */
        --ws-surface: #f6f4f1;
        --ws-surface-hover: #ffffff;
        --ws-muted: var(--color-primary-400, #968b7d);
        --ws-ink: var(--color-primary-700, #4a4039);
        --ws-ring: rgba(150, 139, 125, 0.22);
        /* 图标叠放的底板色必须跟卡片底色一致，否则重叠处会露锗。 */
        --ws-plate: var(--ws-surface);

        width: 100%;
        margin: 0;
        user-select: none;
    }

    /* 顶部触发区与 BuiltInBashToolCallItem 的日志行保持同样的排版与配色。 */
    .web-search-sources__trigger {
        display: block;
        width: 100%;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: default;
        font: inherit;
        text-align: left;
    }

    .web-search-sources__trigger .tool-call-log-line {
        display: block;
        min-width: 0;
        margin: 0;
        overflow: hidden;
        color: rgb(107, 114, 128);
        font-family: inherit;
        font-size: inherit;
        font-weight: inherit;
        line-height: inherit;
        letter-spacing: inherit;
        text-overflow: ellipsis;
        white-space: nowrap;
        transition: color var(--duration-quick) var(--ease-smooth-out);
    }

    .web-search-sources:hover .tool-call-log-line {
        color: rgb(31, 41, 55);
    }

    .tool-call-log-verb {
        font-size: 0.9em;
    }

    .tool-call-log-content,
    .tool-call-log-duration {
        color: rgb(156, 163, 175);
        font-size: 0.9em;
        transition: color var(--duration-quick) var(--ease-smooth-out);
    }

    /*
     * 搜索引擎名独立成标签。
     * 沿用内置工具日志里 `tool-call-server` 徽标的形状与色值：
     * 小徽标用比卡片稍强的底色才能读出来，大面板已经调浅。
     */
    .web-search-sources__engine {
        display: inline-block;
        margin-left: 0.4rem;
        padding: 0.05rem 0.4rem;
        border-radius: 999px;
        background: var(--color-primary-100, #ebe7e3);
        color: var(--color-primary-500, #6b5f54);
        font-size: 10px;
        line-height: 1.4;
        vertical-align: 0.1em;
    }

    .web-search-sources:hover .tool-call-log-content,
    .web-search-sources:hover .tool-call-log-duration {
        color: rgb(75, 85, 99);
    }

    .web-search-sources .tool-call-log-verb,
    .web-search-sources .tool-call-log-content,
    .web-search-sources .tool-call-log-duration {
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
    }

    .web-search-sources__viewport {
        position: relative;
    }

    .web-search-sources__rail {
        display: flex;
        margin: 0;
        /* 负边距给卡片 hover 的抬升留出空间，否则会被轨道裁掉。 */
        padding: 0.62rem 2px 6px;
        gap: 8px;
        overflow-x: auto;
        overflow-y: hidden;
        list-style: none;
        /* 隐藏滚动条但保留滚动能力；可滚性由两侧渐隐 + 滚轮/拖拽提示。 */
        scrollbar-width: none;
        -ms-overflow-style: none;
        overscroll-behavior-x: contain;
    }

    .web-search-sources__rail::-webkit-scrollbar {
        display: none;
        width: 0;
        height: 0;
    }

    /*
     * 两侧渐隐用覆盖层而不是 mask：
     * mask 会把滚动条一并裁掉，且固定宽度会把贴边的首/尾卡片整张抹掉。
     * 宽度由脚本按“实际被藏住的像素量”下发。
     */
    .web-search-sources__fade {
        position: absolute;
        top: 0;
        bottom: 0;
        /* 不拦截指针：滚轮/拖拽要能穿透到轨道上。 */
        pointer-events: none;
    }

    .web-search-sources__fade--start {
        left: 0;
        background: linear-gradient(
            to right,
            var(--ws-fade-bg, rgba(251, 251, 246, 0.98)),
            transparent
        );
    }

    .web-search-sources__fade--end {
        right: 0;
        background: linear-gradient(
            to left,
            var(--ws-fade-bg, rgba(251, 251, 246, 0.98)),
            transparent
        );
    }

    /* 拖拽中：用抓手光标让「可以拖」这件事可见。 */
    .web-search-sources__rail--dragging {
        cursor: grabbing;
    }

    .web-search-sources__rail--dragging .web-search-sources__card {
        cursor: grabbing;
        /* 拖拽时取消 hover 抬升，避免卡片在指针下跳动。 */
        translate: 0;
    }

    .web-search-sources__cell {
        display: flex;
        min-width: 0;
        /* 固定卡宽而不是均分剩余空间，卡片数多于可视宽度时横向滚动。 */
        flex: 0 0 176px;
    }

    .web-search-sources__card {
        display: flex;
        width: 100%;
        height: 84px;
        flex-direction: column;
        justify-content: space-between;
        padding: 10px;
        border: 0;
        border-radius: 14px;
        background: var(--ws-surface);
        color: inherit;
        cursor: pointer;
        text-align: left;
        text-decoration: none;
        outline: none;
        transition:
            background-color 200ms ease,
            box-shadow 200ms ease,
            translate 200ms ease;
    }

    .web-search-sources__cell:hover .web-search-sources__card {
        --ws-plate: var(--ws-surface-hover);

        translate: 0 -2px;
        background: var(--ws-surface-hover);
        box-shadow:
            0 0 0 1px var(--ws-ring),
            0 2px 6px -1px rgba(107, 95, 84, 0.14);
    }

    .web-search-sources__card:focus-visible {
        outline: 2px solid var(--color-primary-300, #b8afa5);
        outline-offset: 2px;
    }

    /* ── 搜索中的骨架占位 ── */
    .web-search-sources__card--skeleton {
        position: relative;
        overflow: hidden;
        cursor: default;
        /* 骨架不参与 hover 抬升/变色，它不是可交互目标。 */
        translate: 0;
    }

    .web-search-sources__cell:hover .web-search-sources__card--skeleton {
        translate: 0;
        background: var(--ws-surface);
        box-shadow: none;
    }

    .web-search-sources__skeleton-lines {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-top: 2px;
    }

    .web-search-sources__skeleton-bar {
        display: block;
        height: 10px;
        border-radius: 999px;
        background: rgb(74 64 57 / 7%);
    }

    /* 扫光：一条斜向亮带自左向右掠过；每张卡用 animation-delay 铺开相位。 */
    .web-search-sources__skeleton-shine {
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(
            100deg,
            transparent 20%,
            rgb(255 255 255 / 72%) 50%,
            transparent 80%
        );
        transform: translateX(-100%);
        animation: web-search-skeleton-shine 1.4s ease-in-out infinite;
    }

    @keyframes web-search-skeleton-shine {
        from {
            transform: translateX(-100%);
        }

        to {
            transform: translateX(100%);
        }
    }

    .web-search-sources__card-title {
        display: -webkit-box;
        overflow: hidden;
        color: var(--ws-ink);
        font-size: 12.5px;
        font-weight: 600;
        line-height: 17px;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
    }

    .web-search-sources__card-meta {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 6px;
    }

    .web-search-sources__card-site {
        flex: 1 1 auto;
        overflow: hidden;
        color: var(--ws-muted);
        font-size: 11.5px;
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .web-search-sources__card-index {
        color: var(--ws-muted);
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        opacity: 0.65;
    }

    @media (prefers-reduced-motion: reduce) {
        .web-search-sources__cell:hover .web-search-sources__card {
            translate: 0;
        }

        /* 骨架保留静态占位，不做扫光。 */
        .web-search-sources__skeleton-shine {
            animation: none;
            opacity: 0;
        }
    }
</style>
