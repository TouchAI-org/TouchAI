<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="mb-4 flex flex-col items-end">
        <div class="bg-primary-100 max-w-[80%] rounded-lg px-4 py-2 break-words">
            <div class="text-[15px] leading-[1.6]">
                <!-- 文本内容 -->
                <div
                    v-if="message.content"
                    class="user-text whitespace-pre-wrap text-gray-900 select-text"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ message.content }}
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
                                class="block max-h-[200px] max-w-xs rounded-lg border border-gray-200 object-contain"
                                data-no-i18n="true"
                                translate="no"
                            />
                        </div>

                        <!-- 文件附件 -->
                        <div
                            v-else
                            class="inline-flex max-w-fit items-center gap-2 rounded border border-gray-200 bg-white p-2"
                        >
                            <AppIcon name="file" class="h-4 w-4 text-gray-500" />
                            <span class="text-sm text-gray-700" data-no-i18n="true" translate="no">
                                {{ attachment.name || t('conversation.attachment.unnamedFile') }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- 复制按钮 - 气泡外部右下角 -->
        <div v-if="message.content" class="mt-1">
            <ActionButton icon="copy" :handler="handleCopy" :aria-label="t('assistant.action.copyMessage')" />
        </div>
    </div>
</template>

<script setup lang="ts">
    import ActionButton from '@components/ActionButton.vue';
    import AppIcon from '@components/AppIcon.vue';
    import { notify } from '@services/NotificationService';

    import { t } from '@/i18n';
    import { clipboardService } from '@/services/ClipboardService';
    import type { SessionMessage } from '@/types/session';

    interface Props {
        message: SessionMessage;
    }

    const props = defineProps<Props>();

    async function handleCopy() {
        try {
            await clipboardService.writeText(props.message.content);
            notify({ title: 'TouchAI', body: t('notification.copy.copiedToClipboard') });
        } catch (error) {
            console.error('[UserMessage] Failed to copy:', error);
            notify({ title: 'TouchAI', body: t('common.copyFailed') });
        }
    }
</script>

<style scoped>
    .user-text {
        font-family:
            'Source Han Serif CN', 'Noto Serif SC', 'Source Han Serif', 'Noto Serif CJK SC', serif;
    }

    .user-text::selection {
        background-color: var(--color-primary-200);
        color: inherit;
    }
</style>
