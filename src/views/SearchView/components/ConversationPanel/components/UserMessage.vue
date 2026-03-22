<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="mb-4 flex justify-end">
        <div class="bg-primary-100 max-w-[80%] rounded-lg px-4 py-2 break-words">
            <div class="text-[15px] leading-[1.6]">
                <div class="user-text text-gray-900 select-text">{{ message.content }}</div>

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
                                :alt="attachment.name || 'Image'"
                                class="block max-h-[200px] max-w-xs rounded-lg border border-gray-200 object-contain"
                            />
                        </div>

                        <!-- 文件附件 -->
                        <div
                            v-else
                            class="inline-flex max-w-fit items-center gap-2 rounded border border-gray-200 bg-white p-2"
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
    import SvgIcon from '@components/SvgIcon.vue';

    import type { ConversationMessage } from '@/types/conversation';

    interface Props {
        message: ConversationMessage;
    }

    defineProps<Props>();
</script>

<style scoped>
    .user-text {
        font-family:
            'Source Han Serif CN', 'Noto Serif SC', 'Source Han Serif', 'Noto Serif CJK SC', serif;
    }
</style>
