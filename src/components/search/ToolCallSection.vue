<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div v-if="toolCalls && toolCalls.length > 0" class="tool-call-section mb-4 w-full">
        <button
            class="flex w-full items-center gap-2 px-1 py-2 text-left text-sm font-normal text-gray-700 transition-colors hover:text-gray-900"
            @click="toggleSection"
        >
            <SvgIcon
                name="chevron-right"
                :class="
                    isExpanded
                        ? 'h-4 w-4 rotate-90 transition-transform'
                        : 'h-4 w-4 transition-transform'
                "
            />
            <span>工具调用</span>
            <span
                v-if="hasExecutingTools"
                class="ml-2 flex items-center gap-1 text-xs text-gray-500"
            >
                <div class="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500"></div>
            </span>
        </button>
        <div v-show="isExpanded" class="tool-call-content mt-2 space-y-2">
            <ToolCallItem v-for="toolCall in toolCalls" :key="toolCall.id" :tool-call="toolCall" />
        </div>
    </div>
</template>

<script setup lang="ts">
    import SvgIcon from '@components/common/SvgIcon.vue';
    import ToolCallItem from '@components/search/ToolCallItem.vue';
    import type { ToolCallInfo } from '@composables/useAgent.ts';
    import { computed, ref, watch } from 'vue';

    interface Props {
        toolCalls?: ToolCallInfo[];
        messageContent: string;
    }

    const props = defineProps<Props>();

    const isExpanded = ref(true);
    const manualOverride = ref(false);

    const hasExecutingTools = computed(() => {
        return props.toolCalls?.some((tc) => tc.status === 'executing') ?? false;
    });

    function toggleSection() {
        isExpanded.value = !isExpanded.value;
        manualOverride.value = true;
    }

    // 当有工具正在执行时自动展开
    watch(
        hasExecutingTools,
        (isExecuting) => {
            if (isExecuting && !manualOverride.value) {
                isExpanded.value = true;
            }
        },
        { immediate: true }
    );

    // 当消息内容从空变为非空时自动折叠
    watch(
        () => props.messageContent,
        (newContent, oldContent) => {
            if (newContent && !oldContent && !manualOverride.value) {
                isExpanded.value = false;
            }
        }
    );
</script>

<style scoped>
    .tool-call-section {
        font-size: 14px;
    }
</style>
