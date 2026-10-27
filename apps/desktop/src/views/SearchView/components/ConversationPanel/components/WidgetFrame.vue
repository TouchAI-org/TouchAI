<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div
        ref="hostRef"
        class="relative isolate block w-full max-w-full min-w-0 overflow-hidden bg-transparent [contain:layout_paint_style]"
        data-no-i18n="true"
        translate="no"
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
    import type { WidgetInfo } from '@/types/session';

    interface Props {
        widget: WidgetInfo;
    }

    const props = defineProps<Props>();

    const hostRef = ref<HTMLElement | null>(null);
    let renderer: WidgetRenderer | null = null;

    // 仅开发用：记录 widget 挂载/卸载/渲染事件，便于排查流式中的闪烁。
    function debugWidgetEvent(event: string, payload: Record<string, unknown> = {}) {
        if (!import.meta.env.DEV) {
            return;
        }

        const target = window as Window & {
            __TOUCHAI_WIDGET_DEBUG__?: Array<Record<string, unknown>>;
        };
        const entries = (target.__TOUCHAI_WIDGET_DEBUG__ ??= []);
        entries.push({ at: Date.now(), event, widgetId: props.widget.widgetId, ...payload });
        if (entries.length > 200) {
            entries.splice(0, entries.length - 200);
        }
    }

    /**
     * 直接把每次 widget 更新交给 renderer，避免 UI 层二次节流后打乱流式节奏。
     */
    function renderCurrentWidget() {
        debugWidgetEvent('render', {
            htmlLength: props.widget.html?.length ?? 0,
            phase: props.widget.phase,
        });
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
        debugWidgetEvent('mount');
        renderCurrentWidget();
    });

    onUnmounted(() => {
        debugWidgetEvent('unmount');
        renderer?.destroy();
        renderer = null;
    });
</script>
