<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div v-if="toolCalls && toolCalls.length > 0" class="tool-call-inline-section w-full">
        <button
            type="button"
            class="tool-call-inline-trigger"
            :aria-expanded="isExpanded"
            @click="toggleSection"
        >
            <div class="tool-call-inline-main">
                <span class="tool-call-inline-icon">
                    <AppIcon name="tool" class="h-3.5 w-3.5" />
                </span>
                <span>{{ summaryText }}</span>
                <span
                    v-if="latestToolName"
                    class="tool-call-inline-latest"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ latestToolName }}
                </span>
            </div>
            <div class="tool-call-inline-meta">
                <span v-if="hasExecutingTools" class="tool-call-inline-running">
                    <span class="tool-call-inline-pulse"></span>
                    {{ t('common.running') }}
                </span>
                <span v-else-if="hasErrorTools" class="tool-call-inline-error">
                    {{ t('conversation.toolCall.hasErrors') }}
                </span>
                <span v-else-if="hasCancelledTools" class="tool-call-inline-cancelled">
                    {{ t('common.cancelled') }}
                </span>
                <span v-else>{{ t('conversation.toolCall.completed') }}</span>
                <AppIcon
                    name="chevron-right"
                    :class="
                        isExpanded
                            ? 'h-4 w-4 rotate-90 transition-transform'
                            : 'h-4 w-4 transition-transform'
                    "
                />
            </div>
        </button>
        <MotionCollapse :open="isExpanded" lazy>
            <div class="tool-call-inline-panel mt-2 space-y-2">
                <ToolCallItem
                    v-for="toolCall in toolCalls"
                    :key="toolCall.id"
                    :tool-call="toolCall"
                />
            </div>
        </MotionCollapse>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import MotionCollapse from '@components/MotionCollapse.vue';
    import { computed, ref, watch } from 'vue';

    import type { ToolCallInfo } from '@/app/api/agent/history';
    import { t } from '@/i18n';

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
        return (
            props.toolCalls?.filter(
                (tc) => tc.status !== 'executing' && tc.status !== 'awaiting_approval'
            ).length ?? 0
        );
    });
    const latestToolName = computed(() => {
        return props.toolCalls?.[props.toolCalls.length - 1]?.name;
    });
    const hasExecutingTools = computed(
        () =>
            props.toolCalls?.some(
                (tc) => tc.status === 'executing' || tc.status === 'awaiting_approval'
            ) ?? false
    );
    const hasErrorTools = computed(
        () => props.toolCalls?.some((tc) => tc.status === 'error') ?? false
    );
    const hasCancelledTools = computed(
        () => props.toolCalls?.some((tc) => tc.status === 'cancelled') ?? false
    );
    const summaryText = computed(() => {
        if (hasExecutingTools.value) {
            return t('conversation.toolCall.summaryRunning', {
                completed: completedTools.value,
                total: totalTools.value,
            });
        }

        return t('conversation.toolCall.summaryComplete', {
            total: totalTools.value,
        });
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
        margin-top: 0;
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
        border: 1px solid var(--color-content-block-border);
        background: var(--color-content-block-surface);
        color: var(--color-text-secondary);
        transition:
            border-color var(--duration-quick) var(--ease-smooth-out),
            background-color var(--duration-quick) var(--ease-smooth-out),
            color var(--duration-quick) var(--ease-smooth-out);
    }

    .tool-call-inline-trigger:hover {
        border-color: var(--color-primary-300);
        background: var(--color-content-block-surface-hover);
        color: var(--color-primary-700);
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
        color: var(--color-text-tertiary);
    }

    .tool-call-inline-latest {
        max-width: 14rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        color: var(--color-text-tertiary);
        font-size: 12px;
    }

    .tool-call-inline-meta {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        font-size: 12px;
        color: var(--color-text-tertiary);
        flex-shrink: 0;
    }

    .tool-call-inline-running {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        color: var(--color-text-info);
    }

    .tool-call-inline-pulse {
        width: 0.4rem;
        height: 0.4rem;
        border-radius: 999px;
        background: currentColor;
        animation: pulse var(--motion-status-cycle) var(--ease-in-out) infinite;
    }

    .tool-call-inline-error {
        color: var(--color-text-danger);
    }

    .tool-call-inline-cancelled {
        color: var(--color-text-tertiary);
    }

    .tool-call-inline-panel {
        padding: 0.45rem;
        border-radius: 0.75rem;
        border: 1px solid var(--color-content-block-border);
        background: var(--color-content-block-surface);
        box-shadow: var(--shadow-content-block);
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
