<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div v-if="userMessages.length > 1" class="conversation-timeline">
        <!-- 时间轴轨道 -->
        <div class="timeline-track"></div>

        <!-- 标记点 -->
        <div
            v-for="marker in markers"
            :key="marker.messageId"
            role="button"
            :aria-label="`跳转到消息: ${marker.preview}`"
            tabindex="0"
            class="timeline-marker"
            :class="{
                active: marker.messageId === activeMarkerId,
            }"
            :style="{ top: `${marker.position}px` }"
            :title="marker.preview"
            @click="handleMarkerClick(marker.messageId)"
            @keydown.enter="handleMarkerClick(marker.messageId)"
            @keydown.space.prevent="handleMarkerClick(marker.messageId)"
        >
            <!-- 悬停提示框 -->
            <div class="marker-tooltip">
                {{ marker.preview }}
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import { truncateText } from '@utils/text';
    import { computed, onUnmounted, ref, watch } from 'vue';

    import type { SessionMessage } from '@/types/session';

    const TIMELINE_TOP_OFFSET = 48;
    const TIMELINE_PADDING_TOP = 20;
    const TIMELINE_PADDING_BOTTOM = 30;
    const PREVIEW_MAX_LENGTH = 50;

    defineOptions({
        name: 'ConversationTimeline',
    });

    interface Props {
        messages: SessionMessage[];
        containerHeight: number;
        scrollTop: number;
        scrollHeight: number;
        clientHeight: number;
    }

    const props = defineProps<Props>();

    const emit = defineEmits<{
        jumpToMessage: [messageId: string];
    }>();

    const activeMarkerId = ref<string | null>(null);
    let detectActiveMarkerTimer: ReturnType<typeof setTimeout> | null = null;

    // 计算属性：仅获取用户消息
    const userMessages = computed(() => {
        return props.messages.filter((msg) => msg.role === 'user');
    });

    interface TimelineMarker {
        messageId: string;
        position: number;
        preview: string;
    }

    // 计算标记位置 - 均匀分布
    const markers = computed<TimelineMarker[]>(() => {
        if (userMessages.value.length <= 1) {
            return [];
        }

        const result: TimelineMarker[] = [];
        const availableHeight = props.containerHeight - TIMELINE_TOP_OFFSET;
        const timelineHeight = availableHeight - TIMELINE_PADDING_TOP - TIMELINE_PADDING_BOTTOM;
        const messageCount = userMessages.value.length;

        userMessages.value.forEach((message, index) => {
            const position =
                messageCount > 1
                    ? TIMELINE_PADDING_TOP + (timelineHeight / (messageCount - 1)) * index
                    : TIMELINE_PADDING_TOP;

            const content = message.content || '';
            const preview = truncateText(content, PREVIEW_MAX_LENGTH);

            result.push({
                messageId: message.id,
                position,
                preview,
            });
        });

        return result;
    });

    function detectActiveMarker() {
        if (userMessages.value.length === 0) {
            activeMarkerId.value = null;
            return;
        }

        const viewportCenter = props.scrollTop + props.clientHeight / 2;

        let closestMessage: SessionMessage | null = null;
        let minDistance = Infinity;

        for (const message of userMessages.value) {
            const escapedId =
                typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                    ? CSS.escape(message.id)
                    : message.id;
            const messageElement = document.querySelector(`[data-message-id="${escapedId}"]`);
            if (!messageElement) continue;

            const element = messageElement as HTMLElement;
            const messageCenter = element.offsetTop + element.offsetHeight / 2;
            const distance = Math.abs(messageCenter - viewportCenter);

            if (distance < minDistance) {
                minDistance = distance;
                closestMessage = message;
            }
        }

        activeMarkerId.value = closestMessage?.id || null;
    }

    function handleMarkerClick(messageId: string) {
        emit('jumpToMessage', messageId);
    }

    watch(
        () => [props.scrollTop, props.messages.length] as const,
        () => {
            if (detectActiveMarkerTimer) {
                clearTimeout(detectActiveMarkerTimer);
            }
            detectActiveMarkerTimer = setTimeout(() => {
                detectActiveMarker();
            }, 50);
        },
        { immediate: true }
    );

    onUnmounted(() => {
        if (detectActiveMarkerTimer) {
            clearTimeout(detectActiveMarkerTimer);
            detectActiveMarkerTimer = null;
        }
    });
</script>

<style scoped>
    .conversation-timeline {
        position: absolute;
        top: v-bind('TIMELINE_TOP_OFFSET + "px"');
        right: 12px;
        bottom: 0;
        width: 16px;
        pointer-events: none;
        z-index: 30;
    }

    .timeline-track {
        position: absolute;
        top: v-bind('TIMELINE_PADDING_TOP + "px"');
        bottom: v-bind('TIMELINE_PADDING_BOTTOM + "px"');
        left: 50%;
        width: 2px;
        background-color: rgba(229, 231, 235, 0.4);
        transform: translateX(-50%);
    }

    .timeline-marker {
        position: absolute;
        left: 50%;
        width: 10px;
        height: 10px;
        background-color: rgba(209, 213, 219, 0.6);
        border: 2px solid white;
        border-radius: 50%;
        transform: translateX(-50%) translateY(-50%);
        cursor: pointer;
        pointer-events: auto;
        transition:
            background-color 0.2s ease,
            transform 0.2s ease,
            box-shadow 0.2s ease;
    }

    .timeline-marker:hover,
    .timeline-marker:focus {
        background-color: rgba(156, 163, 175, 0.8);
        transform: translateX(-50%) translateY(-50%) scale(1.3);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        outline: none;
    }

    .timeline-marker.active {
        background-color: var(--color-primary-500);
        border-color: var(--color-primary-200);
        box-shadow: 0 0 0 4px rgba(107, 95, 84, 0.15);
    }

    .timeline-marker.active:hover {
        background-color: var(--color-primary-600);
    }

    /* 提示框 */
    .marker-tooltip {
        position: absolute;
        right: 100%;
        top: 50%;
        transform: translateY(-50%);
        margin-right: 16px;
        padding: 8px 12px;
        background-color: var(--color-primary-100);
        color: var(--color-primary-700);
        font-size: 12px;
        line-height: 1.5;
        border-radius: 8px;
        border: 1px solid var(--color-primary-200);
        white-space: nowrap;
        max-width: 240px;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    }

    .timeline-marker:hover .marker-tooltip {
        opacity: 1;
    }

    /* 提示框箭头 */
    .marker-tooltip::after {
        content: '';
        position: absolute;
        left: 100%;
        top: 50%;
        transform: translateY(-50%);
        border: 6px solid transparent;
        border-left-color: var(--color-primary-100);
    }
</style>
