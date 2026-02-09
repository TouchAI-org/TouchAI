<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import SvgIcon from '@components/common/SvgIcon.vue';
    import type { Index } from '@services/AiService/attachments';
    import {
        getAttachmentSupportMessage,
        isAttachmentSupported,
    } from '@services/AiService/attachments';
    import type { AttachmentOverflowData } from '@services/PopupService';
    import { emit as tauriEmit } from '@tauri-apps/api/event';
    import { computed, ref } from 'vue';

    interface Props {
        data: AttachmentOverflowData | null;
        isInPopup?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        isInPopup: false,
    });

    const emit = defineEmits<{
        close: [];
    }>();

    // 从 data 解构出附件列表，使用本地副本以支持删除操作
    const localAttachments = ref<Index[]>([]);

    // 当 data 变化时更新本地副本
    const attachments = computed({
        get: () =>
            localAttachments.value.length > 0
                ? localAttachments.value
                : (props.data?.attachments ?? []),
        set: (val) => {
            localAttachments.value = val;
        },
    });

    // 监听 data 变化，重置本地副本
    import { watch } from 'vue';
    watch(
        () => props.data,
        (newData) => {
            if (newData) {
                localAttachments.value = [...newData.attachments];
            }
        },
        { immediate: true }
    );

    function getAttachmentTitle(attachment: Index) {
        return getAttachmentSupportMessage(attachment) || attachment.name;
    }

    function getAttachmentClass(attachment: Index) {
        return [
            'group relative flex items-center gap-3 border-b border-gray-100 px-3 py-2 last:border-b-0',
            isAttachmentSupported(attachment)
                ? 'cursor-pointer hover:bg-gray-50'
                : 'cursor-not-allowed opacity-50 grayscale',
        ];
    }

    async function handlePreview(attachment: Index) {
        if (!isAttachmentSupported(attachment)) return;
        await tauriEmit('popup-attachment-action', {
            action: 'preview',
            attachmentId: attachment.id,
        });
    }

    async function handleRemove(attachment: Index) {
        await tauriEmit('popup-attachment-action', {
            action: 'remove',
            attachmentId: attachment.id,
        });

        // 从本地列表中移除
        localAttachments.value = localAttachments.value.filter((a) => a.id !== attachment.id);

        // 如果列表为空，自动关闭弹窗
        if (localAttachments.value.length === 0) {
            emit('close');
        }
    }
</script>

<template>
    <div
        class="custom-scrollbar-thin max-h-80 w-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg select-none"
    >
        <div
            v-for="attachment in attachments"
            :key="attachment.id"
            :title="getAttachmentTitle(attachment)"
            :class="getAttachmentClass(attachment)"
            @click="handlePreview(attachment)"
        >
            <img
                v-if="attachment.preview"
                :src="attachment.preview"
                :alt="attachment.name"
                class="h-10 w-10 flex-shrink-0 rounded object-cover"
            />
            <div
                v-else
                class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-blue-100 text-xs font-medium text-blue-700"
            >
                {{ attachment.name.split('.').pop()?.toUpperCase().slice(0, 3) || 'FILE' }}
            </div>

            <div class="flex-1 overflow-hidden">
                <p class="truncate text-sm font-medium text-gray-900">{{ attachment.name }}</p>
                <p class="text-xs text-gray-500">
                    {{ attachment.type === 'image' ? '图片' : '文件' }}
                </p>
            </div>

            <button
                class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-gray-400 opacity-0 transition-all group-hover:opacity-100 hover:bg-gray-200 hover:text-gray-600"
                @click.stop="handleRemove(attachment)"
            >
                <SvgIcon name="x" class="h-3.5 w-3.5" />
            </button>
        </div>
    </div>
</template>
