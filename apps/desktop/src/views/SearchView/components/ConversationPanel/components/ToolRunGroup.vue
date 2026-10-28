<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div>
        <button
            type="button"
            class="flex items-center gap-1.5 py-1.5 text-sm opacity-70 transition-opacity hover:opacity-100"
            :aria-expanded="isOpen"
            @click="isOpen = !isOpen"
        >
            <AppIcon
                name="chevron-right"
                class="h-3.5 w-3.5 transition-transform"
                :class="{ 'rotate-90': isOpen }"
            />
            <span>{{ t('conversation.toolRunCollapsed', { count: parts.length }) }}</span>
        </button>

        <!-- 折叠时不挂载子项：历史消息里连续十几个工具卡是首屏最大的开销 -->
        <MotionCollapse :open="isOpen" lazy>
            <div class="flex flex-col gap-1 pl-1">
                <ToolCallItem v-for="part in parts" :key="part.id" :tool-call="part.toolCall" />
            </div>
        </MotionCollapse>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import MotionCollapse from '@components/MotionCollapse.vue';
    import { ref } from 'vue';

    import { t } from '@/i18n';
    import type { ToolCallInfo } from '@/types/session';

    import ToolCallItem from './ToolCallItem.vue';

    interface Props {
        /** 连续的工具调用部件（按原顺序）。 */
        parts: Array<{ id: string; toolCall: ToolCallInfo }>;
    }

    defineProps<Props>();

    const isOpen = ref(false);
</script>
