<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { Index } from '@services/AiService/attachments';
    import {
        getAttachmentSupportMessage,
        isAttachmentSupported,
    } from '@services/AiService/attachments';
    import { popupManager } from '@services/PopupService';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import SvgIcon from '@/components/common/SvgIcon.vue';

    interface Props {
        attachments: Index[];
        maxVisible?: number;
    }

    const props = withDefaults(defineProps<Props>(), {
        maxVisible: 4,
    });

    const emit = defineEmits<{
        remove: [id: string];
        preview: [attachment: Index];
        focusSearchBar: [];
    }>();

    const overflowButtonRef = ref<HTMLElement | null>(null);
    const isOverflowOpen = ref(false);

    // 计算可见附件和溢出附件
    const visibleAttachments = computed(() => {
        return props.attachments.slice(0, props.maxVisible);
    });

    const overflowAttachments = computed(() => {
        return props.attachments.slice(props.maxVisible);
    });

    const hasOverflow = computed(() => {
        return props.attachments.length > props.maxVisible;
    });

    function handleRemove(id: string) {
        emit('remove', id);
    }

    function handlePreview(attachment: Index) {
        if (!isAttachmentSupported(attachment)) return;
        emit('preview', attachment);
    }

    function getAttachmentTitle(attachment: Index) {
        return getAttachmentSupportMessage(attachment) || attachment.name;
    }

    function getAttachmentClass(attachment: Index) {
        return [
            'bg-background-primary group relative flex flex-shrink-0 items-center gap-1.5 rounded border border-gray-200 px-2 py-1 transition-colors',
            isAttachmentSupported(attachment)
                ? 'cursor-pointer hover:border-gray-300'
                : 'cursor-not-allowed opacity-50 grayscale',
        ];
    }

    async function toggleOverflowPopup() {
        if (!overflowButtonRef.value) return;

        try {
            await popupManager.toggle('attachment-overflow-popup', overflowButtonRef.value, {
                attachments: overflowAttachments.value,
            });
            isOverflowOpen.value = !isOverflowOpen.value;
        } catch (error) {
            console.error('[AttachmentList] Failed to toggle overflow popup:', error);
        }
    }

    function handleAttachmentAction(action: 'remove' | 'preview', attachmentId: string) {
        const attachment = props.attachments.find((a) => a.id === attachmentId);
        if (!attachment) return;

        if (action === 'remove') {
            handleRemove(attachmentId);

            if (props.attachments.length === 0 && isOverflowOpen.value) {
                // 附件列表为空，关闭弹窗并聚焦搜索框
                popupManager.hide();
                isOverflowOpen.value = false;
                emit('focusSearchBar');
            } else if (isOverflowOpen.value) {
                // 还有附件，更新弹窗数据
                popupManager.updateData({
                    attachments: overflowAttachments.value,
                });
            }
        } else {
            handlePreview(attachment);
        }
    }

    // 监听附件列表变化
    watch(
        () => props.attachments.length,
        (newLength, oldLength) => {
            // 如果附件从有变为无，且弹窗打开，关闭弹窗
            if (oldLength > 0 && newLength === 0 && isOverflowOpen.value) {
                popupManager.hide();
                isOverflowOpen.value = false;
                emit('focusSearchBar');
            }
        }
    );

    // 清理函数引用
    let cleanupFn: (() => void) | null = null;

    onMounted(async () => {
        // 监听弹窗事件
        cleanupFn = await popupManager.listen({
            onAttachmentAction: handleAttachmentAction,
            onClose: () => {
                isOverflowOpen.value = false;
                // 弹窗关闭时，将焦点返回给搜索框
                emit('focusSearchBar');
            },
        });
    });

    onUnmounted(() => {
        if (cleanupFn) {
            cleanupFn();
        }
    });
</script>

<template>
    <div v-if="attachments.length > 0" class="flex max-w-[30%] items-center gap-2">
        <div
            v-for="attachment in visibleAttachments"
            :key="attachment.id"
            :title="getAttachmentTitle(attachment)"
            :class="getAttachmentClass(attachment)"
            @click="handlePreview(attachment)"
        >
            <img
                v-if="attachment.preview"
                :src="attachment.preview"
                :alt="attachment.name"
                class="h-6 w-6 rounded object-cover"
            />

            <button
                class="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-gray-400 opacity-0 transition-all group-hover:opacity-100 hover:bg-gray-500"
                @click.stop="handleRemove(attachment.id)"
            >
                <SvgIcon name="x" class="h-2 w-2 text-white" />
            </button>
        </div>

        <div
            v-if="hasOverflow"
            ref="overflowButtonRef"
            class="group flex h-6 w-6 cursor-pointer items-center justify-center rounded bg-gray-200 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-300"
            @click="toggleOverflowPopup"
        >
            <span>+{{ overflowAttachments.length }}</span>
        </div>
    </div>
</template>
