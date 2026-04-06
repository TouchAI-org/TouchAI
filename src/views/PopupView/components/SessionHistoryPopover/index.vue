<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div
        data-search-history-popover="true"
        :class="[
            'history-popover max-h-96 overflow-hidden rounded-lg border border-stone-200/90 bg-white shadow-lg backdrop-blur',
            isInPopup ? 'w-full' : 'absolute top-full right-0 z-40 mt-2 w-80',
        ]"
    >
        <div class="border-b border-stone-200/80 px-3 py-2.5">
            <label
                class="history-search-field focus-within:border-primary-300 flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 transition-colors focus-within:bg-white"
            >
                <AppIcon name="search" class="h-3.5 w-3.5 text-stone-400" />
                <input
                    ref="searchInputRef"
                    :value="localSearchQuery"
                    type="text"
                    autofocus
                    placeholder="搜索标题或消息内容"
                    class="w-full border-0 bg-transparent text-xs text-stone-700 outline-none placeholder:text-stone-400"
                    @input="handleSearchInput"
                />
            </label>
        </div>

        <div
            ref="historyListRef"
            class="history-list custom-scrollbar-thin max-h-[20rem] overflow-y-auto px-2 py-2"
        >
            <div
                v-if="isWaitingForSearchResults"
                class="flex min-h-24 items-center justify-center text-xs text-stone-500"
            >
                {{ localSearchQuery.trim() ? '正在搜索会话...' : '正在加载会话历史...' }}
            </div>
            <div
                v-else-if="groupedSessions.length === 0"
                class="flex min-h-24 flex-col items-center justify-center gap-2 px-6 text-center"
            >
                <AppIcon name="history" class="h-7 w-7 text-stone-300" />
                <p class="font-serif text-xs text-stone-700">
                    {{ searchQuery.trim() ? '没有匹配的历史会话' : '还没有历史会话' }}
                </p>
                <p class="text-[11px] leading-4 text-stone-500">
                    {{
                        searchQuery.trim()
                            ? '可以尝试更短的关键词重新搜索'
                            : '发送一条消息后，会话会自动进入历史列表'
                    }}
                </p>
            </div>

            <template v-else>
                <section v-for="group in groupedSessions" :key="group.label" class="py-1">
                    <div
                        class="px-3 py-1.5 text-[10px] font-semibold tracking-[0.12em] text-stone-400 uppercase"
                    >
                        {{ group.label }}
                    </div>

                    <div class="space-y-1">
                        <button
                            v-for="session in group.sessions"
                            :key="session.id"
                            :ref="
                                (el) => {
                                    setSessionRowRef(session.id, el);
                                }
                            "
                            type="button"
                            class="history-session-row flex w-full items-start gap-2 rounded-lg border border-transparent px-3 py-2 text-left transition-colors"
                            :class="{
                                'history-session-row--current': session.id === activeSessionId,
                                'history-session-row--highlighted':
                                    session.id === highlightedSessionId &&
                                    session.id !== activeSessionId,
                            }"
                            data-drag-exclude="true"
                            @mouseenter="highlightedSessionId = session.id"
                            @click="handleOpenSession(session.id)"
                        >
                            <div class="min-w-0 flex-1">
                                <div class="flex min-w-0 items-center gap-2">
                                    <p
                                        class="history-session-title min-w-0 flex-1 font-serif text-xs font-semibold text-stone-900"
                                    >
                                        <span
                                            v-for="(segment, index) in getSessionTitleSegments(
                                                session
                                            )"
                                            :key="`title-${session.id}-${index}`"
                                            :class="segment.matched ? 'history-match' : ''"
                                        >
                                            {{ segment.text }}
                                        </span>
                                    </p>
                                    <div
                                        v-if="getSessionStatus(session.id) === 'running'"
                                        class="border-primary-500 h-3 w-3 animate-spin rounded-full border-2 border-t-transparent"
                                    ></div>
                                    <div
                                        v-else-if="
                                            getSessionStatus(session.id) === 'waiting_approval'
                                        "
                                        class="h-2 w-2 rounded-full bg-blue-500"
                                    ></div>
                                </div>

                                <p
                                    v-if="session.last_message_preview"
                                    class="history-session-preview mt-1 text-[11px] text-stone-500"
                                >
                                    <span
                                        v-for="(segment, index) in getSessionPreviewSegments(
                                            session
                                        )"
                                        :key="`preview-${session.id}-${index}`"
                                        :class="segment.matched ? 'history-match' : ''"
                                    >
                                        {{ segment.text }}
                                    </span>
                                </p>
                                <div
                                    class="mt-1.5 flex items-center gap-2 text-[10px] text-stone-400"
                                >
                                    <span>
                                        {{
                                            formatSessionTime(
                                                session.last_message_at || session.updated_at
                                            )
                                        }}
                                    </span>
                                    <span class="h-1 w-1 rounded-full bg-stone-300"></span>
                                    <span class="truncate">
                                        {{ session.model || '默认模型' }}
                                    </span>
                                </div>
                            </div>
                        </button>
                    </div>
                </section>
            </template>
        </div>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { SessionEntity } from '@database/types';
    import { AppEvent, eventService } from '@services/EventService';
    import type { SessionHistoryData } from '@services/PopupService';
    import type { ComponentPublicInstance } from 'vue';
    import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

    import { useSessionStatus } from '@/composables/useSessionStatus';

    defineOptions({
        name: 'SessionHistoryPopover',
    });

    interface Props {
        data: SessionHistoryData | null;
        isInPopup?: boolean;
    }

    interface SessionGroup {
        label: string;
        sessions: SessionEntity[];
    }

    interface HighlightSegment {
        text: string;
        matched: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        isInPopup: false,
    });

    const emit = defineEmits<{
        close: [];
    }>();

    const searchInputRef = ref<HTMLInputElement | null>(null);
    const historyListRef = ref<HTMLElement | null>(null);
    const highlightedSessionId = ref<number | null>(null);
    const localSearchQuery = ref(props.data?.searchQuery ?? '');
    const sessionRowRefs = ref<Record<number, HTMLElement | null>>({});
    const scrollRequestId = ref(0);

    const sessions = computed<SessionEntity[]>(() => props.data?.sessions ?? []);
    const activeSessionId = computed(() => props.data?.activeSessionId ?? null);
    const searchQuery = computed(() => props.data?.searchQuery ?? '');
    const isLoading = computed(() => props.data?.isLoading ?? false);
    const { getSessionStatus, refreshAllStatuses } = useSessionStatus();

    // 列表由页面层查询，这里只用已提交的 query 做高亮。
    const searchTokens = computed(() => {
        return searchQuery.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    });
    const isWaitingForSearchResults = computed(() => {
        return localSearchQuery.value !== searchQuery.value || isLoading.value;
    });

    function parseSessionDate(value: string): Date {
        const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
        return new Date(normalized);
    }

    function isSameDay(left: Date, right: Date): boolean {
        return (
            left.getFullYear() === right.getFullYear() &&
            left.getMonth() === right.getMonth() &&
            left.getDate() === right.getDate()
        );
    }

    function getSessionGroupLabel(value: string): string {
        const sessionDate = parseSessionDate(value);
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(today.getDate() - 1);
        const previousWeek = new Date(today);
        previousWeek.setDate(today.getDate() - 7);

        if (isSameDay(sessionDate, today)) {
            return '今日';
        }
        if (isSameDay(sessionDate, yesterday)) {
            return '昨天';
        }
        if (sessionDate >= previousWeek) {
            return '近 7 天';
        }
        return '更早';
    }

    const orderedSessions = computed(() => sessions.value);

    const groupedSessions = computed<SessionGroup[]>(() => {
        const groups = new Map<string, SessionEntity[]>();

        for (const session of orderedSessions.value) {
            const groupLabel = getSessionGroupLabel(session.last_message_at || session.updated_at);
            const bucket = groups.get(groupLabel) ?? [];
            bucket.push(session);
            groups.set(groupLabel, bucket);
        }

        return ['今日', '昨天', '近 7 天', '更早']
            .map((label) => ({
                label,
                sessions: groups.get(label) ?? [],
            }))
            .filter((group) => group.sessions.length > 0);
    });

    function formatSessionTime(value: string): string {
        const date = parseSessionDate(value);
        const now = new Date();

        if (isSameDay(date, now)) {
            return new Intl.DateTimeFormat('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            }).format(date);
        }

        return new Intl.DateTimeFormat('zh-CN', {
            month: 'numeric',
            day: 'numeric',
        }).format(date);
    }

    function handleSearchInput(event: Event) {
        const target = event.target as HTMLInputElement;
        localSearchQuery.value = target.value;
        void eventService.emit(AppEvent.POPUP_SESSION_SEARCH_QUERY_CHANGE, {
            query: target.value,
        });
    }

    async function handleOpenSession(sessionId: number) {
        await eventService.emit(AppEvent.POPUP_SESSION_OPEN, { sessionId });
        emit('close');
    }

    function getHighlightedSegments(text: string): HighlightSegment[] {
        if (!text || searchTokens.value.length === 0) {
            return [{ text, matched: false }];
        }

        const normalizedText = text.toLocaleLowerCase();
        const ranges: Array<{ start: number; end: number }> = [];

        // 先收集并合并命中区间，避免高亮把文本切碎。
        for (const token of searchTokens.value) {
            let fromIndex = 0;

            while (fromIndex < normalizedText.length) {
                const matchIndex = normalizedText.indexOf(token, fromIndex);
                if (matchIndex === -1) {
                    break;
                }

                ranges.push({
                    start: matchIndex,
                    end: matchIndex + token.length,
                });
                fromIndex = matchIndex + Math.max(token.length, 1);
            }
        }

        if (ranges.length === 0) {
            return [{ text, matched: false }];
        }

        ranges.sort((left, right) => left.start - right.start || left.end - right.end);

        const mergedRanges: Array<{ start: number; end: number }> = [];
        for (const range of ranges) {
            const previousRange = mergedRanges[mergedRanges.length - 1];
            if (!previousRange || range.start > previousRange.end) {
                mergedRanges.push({ ...range });
                continue;
            }

            previousRange.end = Math.max(previousRange.end, range.end);
        }

        const segments: HighlightSegment[] = [];
        let cursor = 0;

        for (const range of mergedRanges) {
            if (range.start > cursor) {
                segments.push({
                    text: text.slice(cursor, range.start),
                    matched: false,
                });
            }

            segments.push({
                text: text.slice(range.start, range.end),
                matched: true,
            });
            cursor = range.end;
        }

        if (cursor < text.length) {
            segments.push({
                text: text.slice(cursor),
                matched: false,
            });
        }

        return segments.filter((segment) => segment.text.length > 0);
    }

    function getSessionTitleSegments(session: SessionEntity): HighlightSegment[] {
        return getHighlightedSegments(session.title || '未命名会话');
    }

    function getSessionPreviewSegments(session: SessionEntity): HighlightSegment[] {
        return getHighlightedSegments(session.last_message_preview ?? '');
    }

    function resolveSessionRowElement(
        element: Element | ComponentPublicInstance
    ): HTMLElement | null {
        if (element instanceof HTMLElement) {
            return element;
        }

        const componentElement = '$el' in element ? element.$el : null;
        return componentElement instanceof HTMLElement ? componentElement : null;
    }

    function setSessionRowRef(
        sessionId: number,
        element: Element | ComponentPublicInstance | null
    ) {
        if (!element) {
            delete sessionRowRefs.value[sessionId];
            return;
        }

        sessionRowRefs.value[sessionId] = resolveSessionRowElement(element);
    }

    function getSessionIndex(sessionId: number | null): number {
        if (sessionId === null) {
            return -1;
        }

        return orderedSessions.value.findIndex((session) => session.id === sessionId);
    }

    function resolveTopScrollTarget(rowElement: HTMLElement): HTMLElement {
        const groupContainer = rowElement.parentElement;
        const isFirstRowInGroup = groupContainer?.firstElementChild === rowElement;
        const groupSection = rowElement.closest('section');

        return isFirstRowInGroup && groupSection instanceof HTMLElement ? groupSection : rowElement;
    }

    async function scrollToSession(sessionId: number | null, align: 'nearest' | 'top' = 'nearest') {
        if (sessionId === null) {
            return;
        }

        const requestId = ++scrollRequestId.value;
        await nextTick();

        if (requestId !== scrollRequestId.value) {
            return;
        }

        const listElement = historyListRef.value;
        const rowElement = sessionRowRefs.value[sessionId];
        if (!listElement || !rowElement) {
            return;
        }

        const listRect = listElement.getBoundingClientRect();
        const paddingTop = Number.parseFloat(getComputedStyle(listElement).paddingTop || '0') || 0;
        const scrollTarget = resolveTopScrollTarget(rowElement);

        if (align === 'nearest') {
            const rowRect = rowElement.getBoundingClientRect();
            const targetRect = scrollTarget.getBoundingClientRect();

            // 分组首条向上贴边时按 section 对齐，保留标题可见。
            if (scrollTarget !== rowElement && rowRect.top <= listRect.top + paddingTop) {
                listElement.scrollTop += targetRect.top - listRect.top - paddingTop;
                return;
            }

            rowElement.scrollIntoView({
                block: 'nearest',
                behavior: 'auto',
            });
            return;
        }

        // 顶部对齐时优先按 section 滚动，避免分组标题被带出视口。
        const targetRect = scrollTarget.getBoundingClientRect();
        listElement.scrollTop += targetRect.top - listRect.top - paddingTop;
    }

    /**
     * 同步当前高亮，并按需滚动到可见区域。
     */
    function syncHighlightedSession(options?: {
        preferActive?: boolean;
        scroll?: boolean;
        scrollAlign?: 'nearest' | 'top';
    }) {
        const preferActive = options?.preferActive ?? false;
        const shouldScroll = options?.scroll ?? false;
        const scrollAlign = options?.scrollAlign ?? 'nearest';
        const sessions = orderedSessions.value;

        if (sessions.length === 0) {
            highlightedSessionId.value = null;
            return;
        }

        const activeIndex = getSessionIndex(activeSessionId.value);
        const highlightedIndex = getSessionIndex(highlightedSessionId.value);

        let nextSessionId: number;
        if (preferActive && activeIndex >= 0) {
            nextSessionId = sessions[activeIndex]!.id;
        } else if (highlightedIndex >= 0) {
            nextSessionId = sessions[highlightedIndex]!.id;
        } else if (activeIndex >= 0) {
            nextSessionId = sessions[activeIndex]!.id;
        } else {
            nextSessionId = sessions[0]!.id;
        }

        highlightedSessionId.value = nextSessionId;

        if (shouldScroll) {
            void scrollToSession(nextSessionId, scrollAlign);
        }
    }

    function moveHighlight(step: 1 | -1) {
        const sessions = orderedSessions.value;
        if (sessions.length === 0) {
            return;
        }

        const currentIndex = getSessionIndex(highlightedSessionId.value);
        const fallbackIndex = Math.max(getSessionIndex(activeSessionId.value), 0);
        const baseIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
        const nextIndex = Math.min(Math.max(baseIndex + step, 0), sessions.length - 1);
        const nextSession = sessions[nextIndex];

        // 边界处保持原位，避免重复滚动触发额外副作用。
        if (!nextSession || nextIndex === baseIndex) {
            return;
        }

        highlightedSessionId.value = nextSession.id;
        void scrollToSession(nextSession.id, 'nearest');
    }

    /** 初始化或重建列表时，优先把高亮重置到当前会话。 */
    function resetHighlightedSessionToActiveSession(options?: {
        scroll?: boolean;
        scrollAlign?: 'nearest' | 'top';
    }) {
        const activeIndex = getSessionIndex(activeSessionId.value);
        const nextSessionId =
            activeIndex >= 0
                ? orderedSessions.value[activeIndex]!.id
                : (orderedSessions.value[0]?.id ?? null);

        highlightedSessionId.value = nextSessionId;

        if (options?.scroll && nextSessionId !== null) {
            void scrollToSession(nextSessionId, options.scrollAlign ?? 'nearest');
        }
    }

    function handleKeyDown(event: KeyboardEvent) {
        // Ctrl+H 关闭弹窗
        if (event.ctrlKey && event.key === 'h') {
            event.preventDefault();
            emit('close');
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveHighlight(1);
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveHighlight(-1);
            return;
        }

        if (event.key === 'Enter' && highlightedSessionId.value !== null) {
            event.preventDefault();
            void handleOpenSession(highlightedSessionId.value);
        }
    }

    /**
     * popup 真正显示出来后，再由组件自己决定如何接管焦点和初始高亮。
     */
    function handlePopupShown() {
        searchInputRef.value?.focus({ preventScroll: true });
        searchInputRef.value?.select();
        resetHighlightedSessionToActiveSession({
            scroll: true,
            scrollAlign: 'top',
        });
    }

    function loadSessions(loadedSessions: SessionEntity[]) {
        refreshAllStatuses(loadedSessions.map((session) => session.id));
    }

    watch(
        sessions,
        (loadedSessions) => {
            loadSessions(loadedSessions);
        },
        { immediate: true }
    );

    watch(
        () => searchQuery.value,
        (value) => {
            if (value === localSearchQuery.value) {
                return;
            }

            localSearchQuery.value = value;
        }
    );

    watch(
        searchTokens,
        async () => {
            await nextTick();

            // 结果刷新后优先保留现有高亮，失效时再回退到当前会话。
            syncHighlightedSession({
                preferActive: false,
                scroll: true,
                scrollAlign: 'top',
            });
        },
        { flush: 'post' }
    );

    watch(
        () => [orderedSessions.value, activeSessionId.value] as const,
        ([, activeSessionId], previousValue) => {
            const previousActiveSessionId = previousValue?.[1] ?? null;
            syncHighlightedSession({
                preferActive: activeSessionId !== previousActiveSessionId,
                scroll: activeSessionId !== previousActiveSessionId,
                scrollAlign: 'top',
            });
        },
        {
            flush: 'post',
        }
    );

    onUnmounted(() => {
        scrollRequestId.value += 1;
    });

    defineExpose({
        handlePopupShown,
        handleKeyDown,
    });
</script>

<style scoped>
    .history-popover {
        color: rgb(28, 25, 23);
    }

    .history-search-field {
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.55);
    }

    .history-session-row:hover {
        border-color: var(--color-primary-200);
        background: color-mix(in srgb, var(--color-primary-50) 82%, white);
    }

    .history-session-row--highlighted {
        border-color: var(--color-primary-200);
        background: color-mix(in srgb, var(--color-primary-50) 92%, white);
        color: var(--color-primary-600);
    }

    .history-session-row--current {
        border-color: var(--color-primary-300);
        background: var(--color-primary-100);
        color: var(--color-primary-700);
    }

    .history-session-row--highlighted p,
    .history-session-row--highlighted span,
    .history-session-row--current p,
    .history-session-row--current span {
        color: inherit;
    }

    .history-session-title {
        line-height: 1.125rem;
        padding-block: 1px;
        margin-block: -1px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .history-session-preview {
        line-height: 1.125rem;
        padding-block: 1px;
        margin-block: -1px;
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
    }

    .history-match,
    .history-session-row--highlighted .history-match,
    .history-session-row--current .history-match {
        background: color-mix(in srgb, var(--color-primary-100) 90%, white);
        color: var(--color-primary-700);
        font-weight: 600;
        border-radius: 0.2rem;
        padding: 0.02rem 0.18rem;
        line-height: inherit;
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary-300) 78%, white);
        box-decoration-break: clone;
        -webkit-box-decoration-break: clone;
    }
</style>
