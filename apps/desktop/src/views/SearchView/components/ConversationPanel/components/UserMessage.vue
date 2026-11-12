<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="mb-4 flex flex-col items-end">
        <div
            :class="[
                'max-w-[80%] rounded-lg px-4 py-2 break-words',
                isQueued
                    ? 'border border-dashed border-message-muted bg-transparent'
                    : 'bg-secondary',
            ]"
            :data-pending-delivery="message.pendingDelivery"
            :data-queue-drag-handle="isQueued ? '' : undefined"
        >
            <div class="text-reading leading-[1.6]">
                <!-- 文本内容 -->
                <div
                    v-if="inlineParts.length"
                    ref="textElement"
                    :class="[
                        'user-text font-serif whitespace-pre-wrap select-text',
                        isQueued ? 'text-message-muted' : 'text-message-foreground',
                        !isExpanded ? 'line-clamp-6' : '',
                    ]"
                    :data-collapsed="!isExpanded && canCollapse ? 'true' : undefined"
                    data-no-i18n="true"
                    translate="no"
                >
                    <template v-for="(part, index) in inlineParts" :key="index">
                        <SkillLabel v-if="part.type === 'skill'" :name="part.name" />
                        <template v-else>{{ part.text }}</template>
                    </template>
                </div>

                <button
                    v-if="canCollapse"
                    type="button"
                    data-testid="user-message-expand-toggle"
                    class="mt-1 flex items-center gap-1 rounded-md text-caption text-text-tertiary transition-colors hover:text-text-primary"
                    :aria-expanded="isExpanded"
                    @click="isExpanded = !isExpanded"
                >
                    <AppIcon
                        :name="isExpanded ? 'chevron-up' : 'chevron-down'"
                        class="h-3.5 w-3.5"
                    />
                    <span>
                        {{
                            isExpanded
                                ? t('conversation.message.collapse')
                                : t('conversation.message.expand')
                        }}
                    </span>
                </button>

                <!-- 用户消息的附件 -->
                <div
                    v-if="message.attachments && message.attachments.length > 0"
                    class="mt-2 space-y-2"
                >
                    <div v-for="(attachment, index) in message.attachments" :key="index">
                        <!-- 图片附件 -->
                        <div v-if="attachment.type === 'image'" class="image-attachment">
                            <img
                                :src="attachment.preview"
                                :alt="attachment.name || t('conversation.attachment.unnamedImage')"
                                class="block max-h-[200px] max-w-xs rounded-lg border border-message-border object-contain"
                                decoding="async"
                                loading="lazy"
                                data-no-i18n="true"
                                translate="no"
                            />
                        </div>

                        <!-- 文件附件 -->
                        <div
                            v-else
                            class="inline-flex max-w-fit items-center gap-2 rounded border border-message-border bg-message-attachment p-2"
                        >
                            <AppIcon name="file" class="h-4 w-4 text-message-muted" />
                            <span
                                class="text-sm text-message-detail"
                                data-no-i18n="true"
                                translate="no"
                            >
                                {{ attachment.name || t('conversation.attachment.unnamedFile') }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div
            v-if="isQueued"
            data-testid="pending-message-actions"
            class="mt-1 flex items-center gap-1 text-caption text-message-muted"
        >
            <button
                type="button"
                data-testid="pending-message-send-now"
                class="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-text-primary"
                :aria-label="t('conversation.pendingMessage.sendNow')"
                :title="t('conversation.pendingMessage.sendNow')"
                @click="emit('sendNow', message.id)"
            >
                <AppIcon name="arrow-up" class="h-4 w-4" />
            </button>
            <button
                type="button"
                data-testid="pending-message-edit"
                class="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-text-primary"
                :aria-label="t('conversation.pendingMessage.edit')"
                :title="t('conversation.pendingMessage.edit')"
                @click="emit('edit', message.id)"
            >
                <AppIcon name="edit" class="h-3.5 w-3.5" />
            </button>
            <button
                type="button"
                data-testid="pending-message-remove"
                class="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:text-text-primary"
                :aria-label="t('conversation.pendingMessage.remove')"
                :title="t('conversation.pendingMessage.remove')"
                @click="emit('remove', message.id)"
            >
                <AppIcon name="x" class="h-3.5 w-3.5" />
            </button>
        </div>

        <!-- 复制按钮 - 气泡外部右下角 -->
        <div v-if="message.content && !isQueued" class="mt-1">
            <ActionButton
                icon="copy"
                :handler="handleCopy"
                :aria-label="t('assistant.action.copyMessage')"
            />
        </div>
    </div>
</template>

<script setup lang="ts">
    import ActionButton from '@components/ActionButton.vue';
    import AppIcon from '@components/AppIcon.vue';
    import SkillLabel from '@components/SkillLabel.vue';
    import { notify } from '@services/NotificationService';
    import { log } from '@services/ObservabilityService';
    import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { clipboardService } from '@/services/ClipboardService';
    import type { SessionMessage } from '@/types/session';

    import { buildUserMessageInlineParts } from './userMessageParts';

    /** Lines a collapsed user message keeps before the expand control. */
    const COLLAPSED_LINE_COUNT = 6;
    /** Long single-paragraph fallback when no layout metrics are available. */
    const COLLAPSIBLE_CHARACTER_THRESHOLD = 600;

    interface Props {
        message: SessionMessage;
    }

    const props = defineProps<Props>();
    const inlineParts = computed(() =>
        buildUserMessageInlineParts(props.message.content, props.message.inputSnapshot)
    );
    const emit = defineEmits<{
        sendNow: [messageId: string];
        edit: [messageId: string];
        remove: [messageId: string];
    }>();

    const isQueued = computed(() => props.message.pendingDelivery === 'queue');
    const isExpanded = ref(false);

    /**
     * Start from the text shape so the control is correct on the first paint
     * and before any layout exists; the mounted measurement then corrects it
     * for the real bubble width. The character fallback covers one very long
     * paragraph, which has no newlines but still wraps well past six lines.
     */
    function estimateCollapsible(content: string): boolean {
        return (
            content.split('\n').length > COLLAPSED_LINE_COUNT ||
            content.length > COLLAPSIBLE_CHARACTER_THRESHOLD
        );
    }

    const canCollapse = ref(estimateCollapsible(props.message.content));
    const textElement = ref<HTMLElement | null>(null);
    let clearPendingCollapse = false;
    let resizeObserver: ResizeObserver | null = null;

    /**
     * A clamped element still reports the full content height through
     * scrollHeight, which makes this a direct overflow check instead of a
     * character-count guess. While expanded the two heights match, so keep the
     * previous result and do not hide the collapse control.
     *
     * Layout engines used by tests report no box metrics at all, so leave the
     * text-based estimate in place rather than clearing it.
     */
    function measureOverflow() {
        const element = textElement.value;
        if (!element || isExpanded.value) return;
        if (element.clientHeight === 0 && element.scrollHeight === 0) return;
        canCollapse.value = element.scrollHeight > element.clientHeight + 1;
    }

    function scheduleMeasure() {
        void nextTick(() => {
            if (clearPendingCollapse) {
                clearPendingCollapse = false;
                isExpanded.value = false;
            }
            measureOverflow();
        });
    }

    watch(
        () => props.message.id,
        () => {
            clearPendingCollapse = true;
            canCollapse.value = estimateCollapsible(props.message.content);
            scheduleMeasure();
        }
    );
    watch(
        () => props.message.content,
        (content) => {
            isExpanded.value = false;
            canCollapse.value = estimateCollapsible(content);
            scheduleMeasure();
        }
    );

    function handleWindowResize() {
        measureOverflow();
    }

    onMounted(() => {
        scheduleMeasure();
        window.addEventListener('resize', handleWindowResize);
        if (typeof ResizeObserver !== 'undefined' && textElement.value) {
            resizeObserver = new ResizeObserver(measureOverflow);
            resizeObserver.observe(textElement.value);
        }
    });

    // Content can arrive before the element has its final width; measure again
    // once the wrapped text has actually been painted.
    watch(
        () => textElement.value,
        (element) => {
            if (element) {
                scheduleMeasure();
            }
        },
        { flush: 'post' }
    );

    onUnmounted(() => {
        window.removeEventListener('resize', handleWindowResize);
        resizeObserver?.disconnect();
        resizeObserver = null;
    });

    async function handleCopy() {
        try {
            await clipboardService.writeText(props.message.content);
            notify({ title: 'TouchAI', body: t('notification.copy.copiedToClipboard') });
        } catch (error) {
            log.error('[UserMessage] Failed to copy:', error);
            notify({ title: 'TouchAI', body: t('common.copyFailed') });
        }
    }
</script>

<style scoped>
    .user-text::selection {
        background-color: var(--color-message-selection);
        color: inherit;
    }
</style>
