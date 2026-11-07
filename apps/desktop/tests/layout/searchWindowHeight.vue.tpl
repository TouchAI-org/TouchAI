<!-- The browser runner inserts SearchView's production layout and measurement code. -->
<script setup lang="ts">
    import { computed, nextTick, ref } from 'vue';
    import ConversationPanel from '../../src/views/SearchView/components/ConversationPanel/index.vue';
    import SearchBar from 'probe:searchbar';
    import { useMotion } from '../../src/composables/useMotion';
    import {
        SEARCH_SURFACE_MOTION,
        SEARCH_SURFACE_EASING,
        SEARCH_SURFACE_REVEAL_EASING,
    } from '../../src/config/searchWindow';
    import QuickSearchPanel from 'probe:quicksearch';
    import { useSearchWindowResize } from '../../src/views/SearchView/composables/useSearchWindowResize';
    import { resolveAutoSessionPanelHeight } from '../../src/views/SearchView/windowSizing';
    const pageContent = ref(null),
        pageContainer = ref(null),
        searchViewCard = ref(null),
        conversationPanel = ref(null),
        conversationContainer = ref(null);
    const viewReady = ref(false),
        sessionHistory = ref([]),
        isLoading = ref(false),
        searchWindowDefaultSize = ref({ width: 750, height: 60 });
    const quickSearchOpen = ref(false),
        quickSearchHandoff = ref(false),
        quickSearchHandoffShell = ref(null);
    const quickSearchRevealPhase = ref('idle'),
        askUserStore = { current: null };
    const {
        contentReady: searchViewContentReady,
        cardHeight: cardPixelHeight,
        measurementHold: surfaceMeasurementHold,
        fillConversationAvailableHeight,
        effectiveWindowMaximized,
        settledWindowMaximized,
        panelStyle,
        cardStyle,
        isCardGrowing,
        playSessionExpandAnimation,
        remeasureTargetHeight,
        measureTargetHeight,
        scheduleMeasurement: scheduleContentMeasurement,
        ...resize
    } = useSearchWindowResize({
        target: pageContent,
        measureContentHeight: measurePageContentHeight,
        card: searchViewCard,
        sessionCount: computed(() => sessionHistory.value.length),
        quickSearchOpen,
        defaultSize: searchWindowDefaultSize,
        ready: viewReady,
    });
    const { reducedMotion, duration } = useMotion();
    const surfaceAnimationDuration = computed(() =>
        duration(SEARCH_SURFACE_MOTION.durationMs)
    );
    /* __SURFACE_STYLE__ */
    /* __CONTENT_STYLES__ */
    /* __MEASURE_CONTENT__ */
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));

    const message = {
        id: 'assistant',
        role: 'assistant',
        content: '',
        parts: [],
        timestamp: 1,
        isStreaming: true,
    };
    const user = {
        id: 'user',
        role: 'user',
        content: 'Layout regression',
        parts: [],
        timestamp: 1,
    };
    const read = () => {
        const card = searchViewCard.value.getBoundingClientRect(),
            toolbar = document.querySelector('.toolbar-fade-overlay')?.getBoundingClientRect();
        const content = pageContent.value;
        return {
            t: performance.now(),
            card: card.height,
            toolbar: toolbar ? toolbar.top - card.top : null,
            page: content.getBoundingClientRect().height,
            input:
                document.querySelector('[data-testid=search-bar]')?.getBoundingClientRect().bottom -
                card.bottom,
            measure: Math.max(
                content.scrollHeight,
                content.offsetHeight,
                content.getBoundingClientRect().height
            ),
            monitor: resize.monitorHost.value,
            native: resize.currentHeight.value,
        };
    };
    window.probe = {
        focusConversation() {
            conversationPanel.value.focus();
        },
        async remeasureManual() {
            const samples = [];
            let stopped = false;
            const sample = () => {
                samples.push(read());
                if (!stopped) requestAnimationFrame(sample);
            };
            sample();
            await remeasureTargetHeight();
            await pause(750);
            stopped = true;
            return samples;
        },
        async failResize() {
            const input = document.querySelector('[data-testid=search-bar]');
            input.style.height = '160px';
            await pause(750);
            window.rejectResizes = true;
            const before = window.commits.length;
            input.style.height = '60px';
            await pause(900);
            const first = window.commits.length - before;
            await pause(900);
            const later = window.commits.length - before;
            window.rejectResizes = false;
            await remeasureTargetHeight();
            await pause(750);
            return { first, later, ...read() };
        },
        async resizeInput(height) {
            document.querySelector('[data-testid=search-bar]').style.height = `${height}px`;
            await pause(750);
            return read();
        },
        async manual() {
            resize.beginLogicalPanelResize();
            await resize.previewLogicalPanelResize({ width: 750, height: 850 });
            await resize.commitLogicalPanelResize();
            await pause(400);
            return read();
        },
        async maximize() {
            await resize.toggleMaximize();
            await pause(400);
            return read();
        },
        async handoff() {
            sessionHistory.value = [];
            quickSearchOpen.value = true;
            quickSearchRevealPhase.value = 'open';
            await nextTick();
            await remeasureTargetHeight();
            await pause(80);
            surfaceMeasurementHold.value = true;
            quickSearchHandoff.value = true;
            quickSearchRevealPhase.value = 'handoff';
            sessionHistory.value = [user, { ...message }];
            await nextTick();
            const height = await waitForSessionExpandContentHeight();
            await playSessionExpandAnimation(height);
            await pause(400);
            quickSearchOpen.value = false;
            quickSearchHandoff.value = false;
            surfaceMeasurementHold.value = false;
            await pause(700);
            return { height, ...read() };
        },
        async reopen() {
            surfaceMeasurementHold.value = true;
            sessionHistory.value = [user, { ...message }];
            await nextTick();
            const height = await waitForSessionExpandContentHeight();
            await playSessionExpandAnimation(height);
            surfaceMeasurementHold.value = false;
            await pause(700);
            return { height, ...read() };
        },
        async start() {
            await pause(30);
            viewReady.value = true;
            await pause(80);
            await resize.syncWindowState();
            surfaceMeasurementHold.value = true;
            sessionHistory.value = [user, { ...message }];
            isLoading.value = true;
            await nextTick();
            const measured = await waitForSessionExpandContentHeight();
            await playSessionExpandAnimation(measured);
            surfaceMeasurementHold.value = false;
            await pause(700);
            return read();
        },
        async cancel() {
            sessionHistory.value = [
                user,
                {
                    ...message,
                    id: 'cancelled',
                    isStreaming: false,
                    isCancelled: true,
                    content: '请求已取消',
                },
            ];
            isLoading.value = false;
            await nextTick();
            await pause(700);
            return read();
        },
        async stream() {
            const samples = [];
            let stop = false;
            const sample = () => {
                samples.push(read());
                if (!stop) requestAnimationFrame(sample);
            };
            sample();
            for (let i = 1; i <= 12; i++) {
                const text = Array.from({ length: i }, () => 'A streaming line').join('\n');
                sessionHistory.value = [
                    user,
                    {
                        ...message,
                        content: text,
                        parts: [{ id: 'text', type: 'text', content: text }],
                    },
                ];
                await pause(80);
            }
            await pause(800);
            stop = true;
            return samples;
        },
    };
</script>
