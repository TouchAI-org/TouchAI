<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="mb-4 flex flex-col items-end">
        <div
            :class="[
                'max-w-[80%] rounded-lg px-4 py-2 break-words',
                message.pendingDelivery
                    ? 'border border-dashed border-border-subtle bg-transparent text-text-tertiary'
                    : 'bg-secondary',
            ]"
            :data-pending-delivery="message.pendingDelivery"
        >
            <div class="text-reading leading-[1.6]">
                <!-- 文本内容 -->
                <div
                    v-if="inlineParts.length"
                    :class="[
                        'user-text font-serif whitespace-pre-wrap select-text',
                        message.pendingDelivery
                            ? 'text-text-tertiary'
                            : 'text-message-foreground',
                    ]"
                    data-no-i18n="true"
                    translate="no"
                >
                    <template v-for="(part, index) in inlineParts" :key="index">
                        <SkillLabel v-if="part.type === 'skill'" :name="part.name" />
                        <template v-else>{{ part.text }}</template>
                    </template>
                </div>

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

        <!-- 复制按钮 - 气泡外部右下角 -->
        <div v-if="message.content && !message.pendingDelivery" class="mt-1">
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
    import { computed } from 'vue';

    import { t } from '@/i18n';
    import { clipboardService } from '@/services/ClipboardService';
    import type { SessionMessage } from '@/types/session';

    import { buildUserMessageInlineParts } from './userMessageParts';

    interface Props {
        message: SessionMessage;
    }

    const props = defineProps<Props>();
    const inlineParts = computed(() =>
        buildUserMessageInlineParts(props.message.content, props.message.inputSnapshot)
    );

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
