<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div :class="ROOT_CLASS">
        <button
            type="button"
            class="tool-call-log-button"
            :aria-expanded="isExpanded"
            @click="toggleExpanded"
        >
            <span class="tool-call-log-line">
                <span class="tool-call-log-verb">{{ verbText }}</span>
                <span v-if="summaryText" class="tool-call-log-content">
                    {{ ` ${summaryText}` }}
                </span>
                <span v-if="durationText" class="tool-call-log-duration">
                    {{ ` (${durationText})` }}
                </span>
            </span>
        </button>

        <transition name="tool-call-slide">
            <div v-if="isExpanded" class="tool-call-memory-detail">
                <div class="tool-call-memory-panel">
                    <div class="tool-call-memory-panel-header">
                        <span class="tool-call-memory-title">
                            {{ t('conversation.memoryToolCall.section.content') }}
                        </span>
                        <div class="tool-call-memory-panel-header-meta">
                            <span :class="['tool-call-memory-status-text', memoryStatusClass]">
                                {{ memoryStatusText }}
                            </span>
                            <span
                                v-if="durationText"
                                class="tool-call-memory-panel-header-duration"
                            >
                                {{ durationText }}
                            </span>
                        </div>
                    </div>

                    <div class="tool-call-memory-output-block">
                        <pre
                            :class="
                                hasResultOutput
                                    ? 'tool-call-memory-output custom-scrollbar-thin'
                                    : 'tool-call-memory-output tool-call-memory-output--empty custom-scrollbar-thin'
                            "
                            v-text="resultText"
                        ></pre>
                    </div>
                </div>
            </div>
        </transition>
    </div>
</template>

<script setup lang="ts">
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';
    import type { ToolCallInfo } from '@/types/session';

    const ROOT_CLASS =
        'tool-call-memory-wrapper tool-call-log-wrapper paragraph-node touchai-markdown touchai-markdown--default';

    interface Props {
        toolCall: ToolCallInfo;
        verbText: string;
        summaryText: string;
        durationText?: string | null;
    }

    const props = defineProps<Props>();

    const isExpanded = ref(false);
    const statusType = computed<'running' | 'error' | 'completed' | 'rejected' | 'cancelled'>(
        () => {
            if (
                props.toolCall.status === 'executing' ||
                props.toolCall.status === 'awaiting_approval'
            ) {
                return 'running';
            }

            if (props.toolCall.status === 'error') {
                return 'error';
            }

            if (props.toolCall.status === 'rejected') {
                return 'rejected';
            }

            if (props.toolCall.status === 'cancelled') {
                return 'cancelled';
            }

            return 'completed';
        }
    );
    const resultText = computed(() => {
        if (props.toolCall.status === 'awaiting_approval') {
            return t('conversation.toolCall.waitingUserApproval');
        }

        if (props.toolCall.status === 'executing') {
            return t('conversation.memoryToolCall.reading');
        }

        if (props.toolCall.status === 'rejected') {
            return t('conversation.toolCall.userRejected');
        }

        if (props.toolCall.status === 'cancelled') {
            return t('common.requestCancelled');
        }

        const raw = props.toolCall.result?.trim();
        if (raw) {
            return raw;
        }

        if (props.toolCall.status === 'error') {
            return t('conversation.toolCall.noErrorOutput');
        }

        return t('conversation.toolCall.noOutput');
    });
    const hasResultOutput = computed(() => Boolean(props.toolCall.result?.trim()));
    const memoryStatusClass = computed(() => {
        return getStatusClassName('tool-call-memory-status--', statusType.value);
    });
    const memoryStatusText = computed(() => {
        return getToolStatusText(props.toolCall.status, statusType.value, {
            completedText: t('common.success'),
        });
    });

    function getToolStatusText(
        status: ToolCallInfo['status'],
        statusTypeValue: 'running' | 'error' | 'completed' | 'rejected' | 'cancelled',
        options?: {
            completedText?: string;
        }
    ): string {
        if (status === 'awaiting_approval') {
            return t('conversation.memoryToolCall.pendingApproval');
        }

        if (statusTypeValue === 'running') {
            return t('common.running');
        }

        if (statusTypeValue === 'error') {
            return t('common.failed');
        }

        if (statusTypeValue === 'rejected') {
            return t('common.rejected');
        }

        if (statusTypeValue === 'cancelled') {
            return t('common.cancelled');
        }

        return options?.completedText || t('common.done');
    }

    function getStatusClassName(
        prefix: string,
        statusTypeValue: 'running' | 'error' | 'completed' | 'rejected' | 'cancelled'
    ): string {
        if (statusTypeValue === 'running') {
            return `${prefix}running`;
        }

        if (statusTypeValue === 'error') {
            return `${prefix}error`;
        }

        if (statusTypeValue === 'rejected') {
            return `${prefix}rejected`;
        }

        if (statusTypeValue === 'cancelled') {
            return `${prefix}cancelled`;
        }

        return `${prefix}completed`;
    }

    function toggleExpanded() {
        isExpanded.value = !isExpanded.value;
    }
</script>

<style scoped>
    .tool-call-memory-wrapper {
        width: 100%;
        margin: 0;
        cursor: default;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-log-button {
        width: 100%;
        display: block;
        padding: 0;
        border: 0;
        background: transparent;
        text-align: left;
        cursor: default;
        font: inherit;
        color: inherit;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-log-button:focus-visible .tool-call-log-line {
        outline: 1px solid rgba(184, 175, 165, 0.8);
        outline-offset: 2px;
        border-radius: 0.35rem;
    }

    .tool-call-log-line {
        display: block;
        min-width: 0;
        margin: 0;
        overflow: hidden;
        color: rgb(107, 114, 128);
        cursor: default;
        font-family: inherit;
        font-size: inherit;
        font-weight: inherit;
        line-height: inherit;
        letter-spacing: inherit;
        text-overflow: ellipsis;
        white-space: nowrap;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
        transition: color 0.16s ease;
    }

    .tool-call-memory-wrapper:hover .tool-call-log-line {
        color: rgb(75, 85, 99);
    }

    .tool-call-log-verb {
        color: inherit;
        font-size: 0.9em;
    }

    .tool-call-log-content,
    .tool-call-log-duration {
        color: rgb(156, 163, 175);
        font-size: 0.9em;
        transition: color 0.16s ease;
    }

    .tool-call-memory-wrapper
        :is(.tool-call-log-verb, .tool-call-log-content, .tool-call-log-duration) {
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-memory-wrapper:hover .tool-call-log-content,
    .tool-call-memory-wrapper:hover .tool-call-log-duration {
        color: rgb(107, 114, 128);
    }

    .tool-call-memory-detail {
        margin-top: 0.68rem;
    }

    .tool-call-memory-panel {
        border-radius: 0.72rem;
        border: 1px solid rgb(235, 231, 227);
        background: transparent;
        box-shadow: 0 1px 2px rgba(107, 114, 128, 0.04);
        padding: 0.72rem 0.78rem;
    }

    .tool-call-memory-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.55rem;
        flex-wrap: wrap;
    }

    .tool-call-memory-title {
        display: block;
        color: rgb(107, 114, 128);
        font-size: 10px;
        line-height: 1.3;
        font-weight: 500;
        letter-spacing: 0.02em;
    }

    .tool-call-memory-panel-header-meta {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
        flex-wrap: wrap;
        text-align: right;
        margin-left: auto;
    }

    .tool-call-memory-panel-header-duration {
        font-size: 10px;
        line-height: 1.3;
        color: rgb(128, 121, 113);
    }

    .tool-call-memory-output-block {
        margin-top: 0.72rem;
        width: 100%;
        padding: 0;
        border: 0;
        background: transparent;
        overflow: visible;
        text-align: left;
        color: inherit;
        font: inherit;
    }

    .tool-call-memory-output {
        margin: 0;
        padding: 0;
        max-height: 14rem;
        overflow: auto;
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 11px;
        line-height: 1.58;
        color: rgb(96, 92, 87);
        white-space: pre-wrap;
        word-break: break-word;
        user-select: text;
        -webkit-user-select: text;
        -moz-user-select: text;
        -ms-user-select: text;
    }

    .tool-call-memory-output--empty {
        color: rgb(157, 149, 140);
    }

    .tool-call-memory-status-text {
        display: inline-block;
        font-size: 10px;
        line-height: 1.3;
        font-weight: 500;
        color: rgb(102, 96, 89);
    }

    .tool-call-memory-status--running {
        color: rgb(92, 104, 119);
    }

    .tool-call-memory-status--completed {
        color: rgb(102, 96, 89);
    }

    .tool-call-memory-status--cancelled {
        color: rgb(128, 122, 115);
    }

    .tool-call-memory-status--error,
    .tool-call-memory-status--rejected {
        color: rgb(126, 99, 72);
    }

    .tool-call-slide-enter-active,
    .tool-call-slide-leave-active {
        transition:
            opacity 0.2s ease,
            transform 0.2s ease;
    }

    .tool-call-slide-enter-from,
    .tool-call-slide-leave-to {
        opacity: 0;
        transform: translateY(-3px);
    }
</style>
