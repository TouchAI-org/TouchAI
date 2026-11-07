<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="mb-4 flex flex-col items-end">
        <div class="max-w-[80%] rounded-lg bg-primary-100 px-4 py-2 break-words">
            <div class="text-reading leading-[1.6]">
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
                    ref="attachmentListRef"
                    class="mt-2 space-y-2"
                >
                    <div v-for="(attachment, index) in message.attachments" :key="index">
                        <!-- 图片附件 -->
                        <div
                            v-if="attachment.type === 'image'"
                            class="image-attachment"
                            :data-image-index="index"
                        >
                            <img
                                :src="thumbnails[index] ?? attachment.preview"
                                :alt="attachment.name || t('conversation.attachment.unnamedImage')"
                                class="block max-h-[200px] max-w-xs rounded-lg border border-gray-200 object-contain"
                                decoding="async"
                                loading="lazy"
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
    import { notify } from '@services/NotificationService';
    import { log } from '@services/ObservabilityService';
    import { nextTick, onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { clipboardService } from '@/services/ClipboardService';
    import type { SessionMessage } from '@/types/session';
    import { getImageThumbnail } from '@/utils/imageThumbnail';

    interface Props {
        message: SessionMessage;
    }

    const props = defineProps<Props>();

    const attachmentListRef = ref<HTMLElement | null>(null);

    /** 图片信息卡展示宽度上限（对应 max-w-xs），按 DPR 放大。 */
    const THUMBNAIL_BASE_WIDTH = 320;
    const thumbnailWidth = ref(
        typeof window === 'undefined'
            ? THUMBNAIL_BASE_WIDTH
            : Math.round(THUMBNAIL_BASE_WIDTH * Math.min(window.devicePixelRatio || 1, 2))
    );
    const thumbnails = ref<Record<number, string>>({});
    let thumbnailObserver: IntersectionObserver | null = null;
    const observedImages = new Set<number>();

    async function ensureThumbnail(index: number, preview: string | undefined) {
        if (!preview || thumbnails.value[index] || observedImages.has(index)) {
            return;
        }

        observedImages.add(index);
        try {
            const url = await getImageThumbnail(preview, thumbnailWidth.value);
            thumbnails.value = { ...thumbnails.value, [index]: url };
        } catch {
            // 生成失败时保留原图 URL，不影响消息展示。
            observedImages.delete(index);
        }
    }

    // 图片进入可视区才解码缩略图，避免长会话一次性解码全部历史图片。
    watch(
        () => props.message.attachments,
        (attachments) => {
            if (!attachments?.length) {
                return;
            }

            const imageIndexes = attachments
                .map((attachment, index) => (attachment.type === 'image' ? index : -1))
                .filter((index) => index >= 0);
            if (imageIndexes.length === 0) {
                return;
            }

            void nextTick(() => {
                const container = attachmentListRef.value;
                if (!container) {
                    return;
                }

                const nodes = Array.from(
                    container.querySelectorAll<HTMLElement>('[data-image-index]')
                );

                if (typeof IntersectionObserver !== 'function') {
                    for (const node of nodes) {
                        const index = Number(node.dataset.imageIndex);
                        void ensureThumbnail(index, attachments[index]?.preview);
                    }
                    return;
                }

                thumbnailObserver?.disconnect();
                thumbnailObserver = new IntersectionObserver((entries) => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) {
                            continue;
                        }
                        const index = Number((entry.target as HTMLElement).dataset.imageIndex);
                        thumbnailObserver?.unobserve(entry.target);
                        void ensureThumbnail(index, attachments[index]?.preview);
                    }
                });

                for (const node of nodes) {
                    thumbnailObserver.observe(node);
                }
            });
        },
        { immediate: true }
    );

    onUnmounted(() => {
        thumbnailObserver?.disconnect();
        thumbnailObserver = null;
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
    .user-text {
        font-family: 'TouchAI Source Han Serif SC', 'Noto Serif SC', serif;
    }

    .user-text::selection {
        background-color: var(--color-primary-200);
        color: inherit;
    }
</style>
