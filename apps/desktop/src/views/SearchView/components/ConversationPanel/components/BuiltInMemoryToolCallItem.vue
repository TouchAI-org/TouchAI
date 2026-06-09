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
                <span
                    v-if="summaryText"
                    class="tool-call-log-content"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ ` ${summaryText}` }}
                </span>
                <span
                    v-if="durationText"
                    class="tool-call-log-duration"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ ` (${durationText})` }}
                </span>
            </span>
        </button>

        <transition name="tool-call-slide">
            <div v-if="isExpanded" class="tool-call-memory-detail">
                <div class="tool-call-memory-panel">
                    <h4 class="tool-call-memory-title">
                        {{ t('conversation.memoryToolCall.section.content') }}
                    </h4>
                    <pre
                        :class="
                            hasContent
                                ? 'tool-call-memory-content custom-scrollbar-thin'
                                : 'tool-call-memory-content tool-call-memory-content--empty custom-scrollbar-thin'
                        "
                        :data-no-i18n="hasContent ? 'true' : undefined"
                        :translate="hasContent ? 'no' : undefined"
                        v-text="contentText"
                    ></pre>
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
    const contentText = computed(() => {
        if (props.toolCall.status === 'awaiting_approval') {
            return t('conversation.memoryToolCall.pendingApproval');
        }

        if (props.toolCall.status === 'executing') {
            return t('conversation.memoryToolCall.reading');
        }

        const result = props.toolCall.result?.trim();
        if (result) {
            return result;
        }

        if (props.toolCall.status === 'rejected') {
            return t('conversation.toolCall.userRejected');
        }

        if (props.toolCall.status === 'cancelled') {
            return t('common.requestCancelled');
        }

        if (props.toolCall.status === 'error') {
            return t('conversation.toolCall.noErrorOutput');
        }

        return t('conversation.toolCall.noOutput');
    });
    const hasContent = computed(() => Boolean(props.toolCall.result?.trim()));

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

    .tool-call-memory-title {
        margin: 0;
        font-family: var(--font-serif), serif;
        font-size: 12px;
        line-height: 1.35;
        font-weight: 600;
        color: rgb(93, 87, 81);
    }

    .tool-call-memory-content {
        margin: 0.65rem 0 0;
        padding: 0;
        max-height: 14rem;
        overflow: auto;
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 11px;
        line-height: 1.58;
        color: rgb(96, 92, 87);
        white-space: pre-wrap;
        word-break: break-word;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-memory-content--empty {
        color: rgb(157, 149, 140);
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
