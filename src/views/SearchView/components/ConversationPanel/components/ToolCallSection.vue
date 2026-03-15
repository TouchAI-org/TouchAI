<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div v-if="toolCalls && toolCalls.length > 0" class="tool-call-inline-section w-full">
        <button type="button" class="tool-call-inline-trigger" @click="toggleSection">
            <div class="tool-call-inline-main">
                <span class="tool-call-inline-icon">
                    <SvgIcon name="tool" class="h-3.5 w-3.5" />
                </span>
                <span>{{ summaryText }}</span>
                <span v-if="latestToolName" class="tool-call-inline-latest">
                    {{ latestToolName }}
                </span>
            </div>
            <div class="tool-call-inline-meta">
                <span v-if="hasExecutingTools" class="tool-call-inline-running">
                    <span class="tool-call-inline-pulse"></span>
                    运行中
                </span>
                <span v-else-if="hasErrorTools" class="tool-call-inline-error">含错误</span>
                <span v-else>已完成</span>
                <SvgIcon
                    name="chevron-right"
                    :class="
                        isExpanded
                            ? 'h-4 w-4 rotate-90 transition-transform'
                            : 'h-4 w-4 transition-transform'
                    "
                />
            </div>
        </button>
        <transition name="tool-call-fade">
            <div v-show="isExpanded" class="tool-call-inline-panel mt-2 space-y-1.5">
                <ToolCallItem
                    v-for="toolCall in toolCalls"
                    :key="toolCall.id"
                    :tool-call="toolCall"
                />
            </div>
        </transition>
    </div>
</template>

<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import type { ToolCallInfo } from '@composables/useAgent.ts';
    import { computed, ref, watch } from 'vue';

    import ToolCallItem from './ToolCallItem.vue';

    interface Props {
        toolCalls?: ToolCallInfo[];
        messageContent: string;
    }

    const props = defineProps<Props>();

    const isExpanded = ref(false);
    const manualOverride = ref(false);

    const totalTools = computed(() => props.toolCalls?.length ?? 0);
    const completedTools = computed(() => {
        return props.toolCalls?.filter((tc) => tc.status !== 'executing').length ?? 0;
    });
    const latestToolName = computed(() => {
        return props.toolCalls?.[props.toolCalls.length - 1]?.name;
    });
    const hasExecutingTools = computed(
        () => props.toolCalls?.some((tc) => tc.status === 'executing') ?? false
    );
    const hasErrorTools = computed(
        () => props.toolCalls?.some((tc) => tc.status === 'error') ?? false
    );
    const summaryText = computed(() => {
        if (hasExecutingTools.value) {
            return `正在调用工具 (${completedTools.value}/${totalTools.value})`;
        }

        return `工具调用 (${totalTools.value})`;
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
    .tool-call-inline-section {
        margin-top: 0.75rem;
        font-size: 13px;
    }

    .tool-call-inline-trigger {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.45rem 0.65rem;
        border-radius: 0.75rem;
        border: 1px solid rgba(209, 213, 219, 0.9);
        background: rgba(249, 250, 251, 0.7);
        color: rgb(75, 85, 99);
        transition:
            border-color 0.2s ease,
            background-color 0.2s ease,
            color 0.2s ease;
    }

    .tool-call-inline-trigger:hover {
        border-color: rgb(156, 163, 175);
        background: rgba(243, 244, 246, 0.85);
        color: rgb(31, 41, 55);
    }

    .tool-call-inline-main {
        display: flex;
        align-items: center;
        min-width: 0;
        gap: 0.45rem;
        font-size: 12px;
        font-weight: 500;
    }

    .tool-call-inline-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: rgb(107, 114, 128);
    }

    .tool-call-inline-latest {
        max-width: 14rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: rgb(107, 114, 128);
        font-size: 12px;
    }

    .tool-call-inline-meta {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 12px;
        color: rgb(107, 114, 128);
        flex-shrink: 0;
    }

    .tool-call-inline-running {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        color: rgb(37, 99, 235);
    }

    .tool-call-inline-pulse {
        width: 0.4rem;
        height: 0.4rem;
        border-radius: 999px;
        background: rgb(59, 130, 246);
        animation: pulse 1.3s ease-in-out infinite;
    }

    .tool-call-inline-error {
        color: rgb(220, 38, 38);
    }

    .tool-call-inline-panel {
        padding: 0.45rem;
        border-radius: 0.75rem;
        border: 1px solid rgba(229, 231, 235, 0.9);
        background: rgba(249, 250, 251, 0.65);
    }

    .tool-call-fade-enter-active,
    .tool-call-fade-leave-active {
        transition:
            opacity 0.2s ease,
            transform 0.2s ease;
    }

    .tool-call-fade-enter-from,
    .tool-call-fade-leave-to {
        opacity: 0;
        transform: translateY(-3px);
    }

    @keyframes pulse {
        0%,
        100% {
            opacity: 0.4;
        }
        50% {
            opacity: 1;
        }
    }
</style>
