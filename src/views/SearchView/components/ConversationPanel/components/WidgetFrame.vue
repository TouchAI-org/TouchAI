<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div
        ref="hostRef"
        class="relative isolate mt-[0.1rem] mb-[0.3rem] block w-full max-w-full min-w-0 overflow-hidden bg-transparent [contain:layout_paint_style]"
        :data-widget-phase="widget.phase"
        :title="widget.title"
    ></div>
</template>

<script setup lang="ts">
    import { onMounted, onUnmounted, ref, watch } from 'vue';

    import {
        createWidgetRenderer,
        type WidgetRenderer,
    } from '@/services/BuiltInToolService/tools/widgetTool';
    import type { WidgetInfo } from '@/types/conversation';

    interface Props {
        widget: WidgetInfo;
    }

    const props = defineProps<Props>();

    const hostRef = ref<HTMLElement | null>(null);
    let renderer: WidgetRenderer | null = null;
    /**
     * 直接把每次 widget 更新交给 renderer，避免 UI 层二次节流后打乱流式节奏。
     */
    function renderCurrentWidget() {
        renderer?.render({
            widgetId: props.widget.widgetId,
            title: props.widget.title,
            description: props.widget.description,
            html: props.widget.html,
            phase: props.widget.phase,
        });
    }

    watch(
        () => [
            props.widget.widgetId,
            props.widget.html,
            props.widget.title,
            props.widget.description,
            props.widget.phase,
        ],
        () => {
            renderCurrentWidget();
        },
        { flush: 'sync' }
    );

    onMounted(() => {
        if (!hostRef.value) {
            return;
        }

        renderer = createWidgetRenderer(hostRef.value);
        renderCurrentWidget();
    });

    onUnmounted(() => {
        renderer?.destroy();
        renderer = null;
    });
</script>
