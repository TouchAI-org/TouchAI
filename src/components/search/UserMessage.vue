<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="message-bubble justify-end">
        <div class="message-content bg-primary-100 max-w-[80%] rounded-lg px-4 py-2">
            <div class="user-message">
                <div class="user-text user-select-text text-gray-900">{{ message.content }}</div>

                <!-- 用户消息的附件 -->
                <div
                    v-if="message.attachments && message.attachments.length > 0"
                    class="attachments mt-2 space-y-2"
                >
                    <div
                        v-for="(attachment, index) in message.attachments"
                        :key="index"
                        class="attachment-item"
                    >
                        <!-- 图片附件 -->
                        <div v-if="attachment.type === 'image'" class="image-attachment">
                            <img
                                :src="attachment.preview"
                                :alt="attachment.name || 'Image'"
                                class="max-w-xs rounded-lg border border-gray-200"
                            />
                        </div>

                        <!-- 文件附件 -->
                        <div
                            v-else
                            class="file-attachment flex items-center gap-2 rounded border border-gray-200 bg-white p-2"
                        >
                            <SvgIcon name="file" class="h-4 w-4 text-gray-500" />
                            <span class="text-sm text-gray-700">
                                {{ attachment.name || 'File' }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
    import SvgIcon from '@components/common/SvgIcon.vue';
    import type { ConversationMessage } from '@composables/useAgent.ts';

    interface Props {
        message: ConversationMessage;
    }

    defineProps<Props>();
</script>

<style scoped>
    .message-bubble {
        display: flex;
        margin-bottom: 1rem;
    }

    .message-content {
        word-wrap: break-word;
        overflow-wrap: break-word;
    }

    .user-message {
        font-size: 15px;
        line-height: 1.6;
    }

    .user-text {
        font-family:
            'Source Han Serif CN', 'Noto Serif SC', 'Source Han Serif', 'Noto Serif CJK SC', serif;
    }

    .attachments {
        display: flex;
        flex-direction: column;
    }

    .image-attachment img {
        display: block;
        max-height: 200px;
        object-fit: contain;
    }

    .file-attachment {
        display: inline-flex;
        max-width: fit-content;
    }

    /* 用户消息允许选中文字 */
    .user-select-text {
        user-select: text;
        -webkit-user-select: text;
        -moz-user-select: text;
        -ms-user-select: text;
    }
</style>
