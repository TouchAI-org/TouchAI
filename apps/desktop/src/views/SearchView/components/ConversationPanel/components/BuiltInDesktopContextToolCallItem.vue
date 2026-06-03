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
            <div v-if="isExpanded" class="tool-call-desktop-context-detail">
                <div class="tool-call-desktop-context-panel">
                    <div class="tool-call-desktop-context-panel-header">
                        <span class="tool-call-desktop-context-title">
                            {{ t('conversation.desktopContext.title') }}
                        </span>
                        <div class="tool-call-desktop-context-panel-header-meta">
                            <span :class="['tool-call-desktop-context-status', statusClass]">
                                {{ statusText }}
                            </span>
                            <span
                                v-if="durationText"
                                class="tool-call-desktop-context-duration"
                                data-no-i18n="true"
                                translate="no"
                            >
                                {{ durationText }}
                            </span>
                        </div>
                    </div>

                    <a
                        v-if="screenshotUrl"
                        :href="screenshotUrl"
                        target="_blank"
                        rel="noreferrer"
                        class="tool-call-desktop-context-screenshot-link"
                    >
                        <img
                            :src="screenshotUrl"
                            :alt="t('conversation.desktopContext.screenshotAlt')"
                            class="tool-call-desktop-context-screenshot"
                            data-no-i18n="true"
                            translate="no"
                        />
                    </a>
                    <pre
                        v-else-if="screenshotPath"
                        class="tool-call-desktop-context-screenshot-path"
                        data-no-i18n="true"
                        translate="no"
                        v-text="screenshotPath"
                    ></pre>

                    <pre
                        class="tool-call-desktop-context-raw custom-scrollbar-thin"
                        :data-no-i18n="isResultPayload ? 'true' : undefined"
                        :translate="isResultPayload ? 'no' : undefined"
                        v-text="resultText"
                    ></pre>
                </div>
            </div>
        </transition>
    </div>
</template>

<script setup lang="ts">
    import { convertFileSrc } from '@tauri-apps/api/core';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';
    import type { ToolCallInfo } from '@/types/session';

    const ROOT_CLASS =
        'tool-call-desktop-context-wrapper tool-call-log-wrapper paragraph-node touchai-markdown touchai-markdown--default';

    interface Props {
        toolCall: ToolCallInfo;
        verbText: string;
        summaryText: string;
        durationText?: string | null;
    }

    const props = defineProps<Props>();
    const isExpanded = ref(false);

    const parsedResult = computed(() => {
        const raw = props.toolCall.result?.trim();
        if (!raw) {
            return null;
        }

        try {
            return JSON.parse(raw) as Record<string, unknown>;
        } catch {
            return null;
        }
    });
    const screenshotPath = computed(() => {
        const screenshot = parsedResult.value?.screenshot;
        if (!screenshot || typeof screenshot !== 'object') {
            return null;
        }

        const path = (screenshot as { path?: unknown }).path;
        return typeof path === 'string' && path.trim() ? path : null;
    });
    const screenshotUrl = computed(() => {
        return screenshotPath.value ? convertFileSrc(screenshotPath.value) : null;
    });
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
    const statusClass = computed(() => `tool-call-desktop-context-status--${statusType.value}`);
    const statusText = computed(() => getToolStatusText(props.toolCall.status, statusType.value));
    const resultText = computed(() => {
        if (props.toolCall.status === 'executing') {
            return t('conversation.toolCall.executing');
        }

        if (props.toolCall.status === 'awaiting_approval') {
            return t('conversation.toolCall.waitingUserApproval');
        }

        const raw = props.toolCall.result?.trim();
        if (raw) {
            return raw;
        }

        if (props.toolCall.status === 'error') {
            return t('conversation.toolCall.noErrorOutput');
        }

        if (props.toolCall.status === 'rejected') {
            return t('conversation.toolCall.userRejected');
        }

        if (props.toolCall.status === 'cancelled') {
            return t('common.requestCancelled');
        }

        return t('conversation.toolCall.noOutput');
    });
    const isResultPayload = computed(() => Boolean(props.toolCall.result?.trim()));

    function getToolStatusText(
        status: ToolCallInfo['status'],
        statusTypeValue: 'running' | 'error' | 'completed' | 'rejected' | 'cancelled'
    ): string {
        if (status === 'awaiting_approval') {
            return t('conversation.toolCall.waitingApproval');
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

        return t('common.success');
    }

    function toggleExpanded() {
        isExpanded.value = !isExpanded.value;
    }
</script>

<style scoped>
    .tool-call-desktop-context-wrapper {
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

    .tool-call-desktop-context-wrapper:hover .tool-call-log-line {
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

    .tool-call-desktop-context-wrapper:hover .tool-call-log-content,
    .tool-call-desktop-context-wrapper:hover .tool-call-log-duration {
        color: rgb(107, 114, 128);
    }

    .tool-call-desktop-context-detail {
        margin-top: 0.68rem;
    }

    .tool-call-desktop-context-panel {
        border-radius: 0.72rem;
        border: 1px solid rgb(235, 231, 227);
        background: transparent;
        box-shadow: 0 1px 2px rgba(107, 114, 128, 0.04);
        padding: 0.72rem 0.78rem;
    }

    .tool-call-desktop-context-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.55rem;
        flex-wrap: wrap;
    }

    .tool-call-desktop-context-title {
        display: block;
        color: rgb(107, 114, 128);
        font-size: 10px;
        line-height: 1.3;
        font-weight: 500;
        letter-spacing: 0.02em;
        text-transform: lowercase;
    }

    .tool-call-desktop-context-panel-header-meta {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
        flex-wrap: wrap;
        text-align: right;
        margin-left: auto;
    }

    .tool-call-desktop-context-duration {
        font-size: 10px;
        line-height: 1.3;
        color: rgb(128, 121, 113);
    }

    .tool-call-desktop-context-screenshot-link {
        display: block;
        width: fit-content;
        max-width: 100%;
        margin-top: 0.72rem;
    }

    .tool-call-desktop-context-screenshot {
        display: block;
        max-width: min(100%, 28rem);
        max-height: 14rem;
        border-radius: 0.55rem;
        border: 1px solid rgb(235, 231, 227);
        object-fit: contain;
        background: rgb(250, 249, 247);
    }

    .tool-call-desktop-context-screenshot-path,
    .tool-call-desktop-context-raw {
        margin: 0.72rem 0 0;
        padding: 0;
        max-height: 16rem;
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

    .tool-call-desktop-context-screenshot-path {
        color: rgb(128, 121, 113);
    }

    .tool-call-desktop-context-status {
        display: inline-block;
        font-size: 10px;
        line-height: 1.3;
        font-weight: 500;
        color: rgb(102, 96, 89);
    }

    .tool-call-desktop-context-status--running {
        color: rgb(92, 104, 119);
    }

    .tool-call-desktop-context-status--completed {
        color: rgb(102, 96, 89);
    }

    .tool-call-desktop-context-status--cancelled {
        color: rgb(128, 122, 115);
    }

    .tool-call-desktop-context-status--error,
    .tool-call-desktop-context-status--rejected {
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
