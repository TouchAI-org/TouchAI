<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <BuiltInBashToolCallItem
        v-if="builtinCardComponent"
        :tool-call="toolCall"
        :verb-text="builtinVerbText"
        :summary-text="builtinSummaryText"
        :duration-text="builtinDurationText"
    />
    <div v-else :class="rootClass" @mousedown="handleMouseDown">
        <template v-if="isBuiltinTool">
            <div class="tool-call-log-line">
                <span class="tool-call-log-verb">{{ builtinVerbText }}</span>
                <span v-if="builtinSummaryText" class="tool-call-log-content">
                    {{ ` ${builtinSummaryText}` }}
                </span>
                <span v-if="builtinDurationText" class="tool-call-log-duration">
                    {{ ` (${builtinDurationText})` }}
                </span>
            </div>
        </template>

        <template v-else>
            <button
                type="button"
                class="tool-call-toggle"
                :aria-expanded="isExpanded"
                @click="toggleExpanded"
            >
                <div class="tool-call-main">
                    <AppIcon name="wrench" class="tool-call-icon" />
                    <div class="tool-call-text">
                        <div class="tool-call-title-row">
                            <span class="tool-call-label">{{ toolDisplayName }}</span>
                            <span v-if="toolBadgeLabel" class="tool-call-server">
                                {{ toolBadgeLabel }}
                            </span>
                        </div>
                    </div>
                </div>
                <div class="tool-call-meta">
                    <span :class="['tool-call-status', cardStatusClass]">
                        <span v-if="statusType === 'running'" class="tool-call-pulse"></span>
                        {{ statusText }}
                    </span>
                    <span v-if="toolCall.durationMs" class="tool-call-duration">
                        {{ toolCall.durationMs }}ms
                    </span>
                    <AppIcon
                        name="chevron-right"
                        :class="
                            isExpanded
                                ? 'tool-call-arrow tool-call-arrow--expanded'
                                : 'tool-call-arrow'
                        "
                    />
                </div>
            </button>

            <transition name="tool-call-slide">
                <div v-if="isExpanded" class="tool-call-detail">
                    <div class="tool-call-section">
                        <h4 class="tool-call-section-title">参数</h4>
                        <pre
                            class="tool-call-block custom-scrollbar-thin"
                            v-text="argumentsText"
                        ></pre>
                    </div>

                    <div class="tool-call-section">
                        <h4 class="tool-call-section-title">结果</h4>
                        <pre
                            class="tool-call-block custom-scrollbar-thin"
                            v-text="resultText"
                        ></pre>
                    </div>
                </div>
            </transition>
        </template>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { Component } from 'vue';
    import { computed, ref } from 'vue';

    import type { ToolCallInfo } from '@/types/session';

    import BuiltInBashToolCallItem from './BuiltInBashToolCallItem.vue';

    const BUILTIN_ROOT_CLASS =
        'tool-call-log-wrapper paragraph-node touchai-markdown touchai-markdown--default';
    const BUILTIN_CARD_COMPONENTS: Record<string, Component> = {
        bash: BuiltInBashToolCallItem,
    };

    interface Props {
        toolCall: ToolCallInfo;
    }

    const props = defineProps<Props>();

    const isExpanded = ref(false);
    const isBuiltinTool = computed(() => {
        return (
            props.toolCall.source === 'builtin' || props.toolCall.sourceLabel?.trim() === '内置工具'
        );
    });
    const builtinToolToken = computed(() => {
        return (
            normalizeToolToken(props.toolCall.namespacedName) ||
            normalizeToolToken(props.toolCall.name)
        );
    });
    const builtinCardComponent = computed(() => {
        if (!isBuiltinTool.value) {
            return null;
        }

        return BUILTIN_CARD_COMPONENTS[builtinToolToken.value] ?? null;
    });
    const rootClass = computed(() => {
        if (isBuiltinTool.value) {
            return BUILTIN_ROOT_CLASS;
        }

        return 'my-2 w-full';
    });
    const toolDisplayName = computed(() => {
        const trimmed = props.toolCall.name?.trim();
        if (trimmed) {
            return trimmed;
        }

        const namespaced = props.toolCall.namespacedName?.trim();
        if (namespaced) {
            return namespaced;
        }

        return '未命名工具';
    });
    const toolBadgeLabel = computed(() => {
        return props.toolCall.serverName || props.toolCall.sourceLabel || null;
    });
    const argumentsText = computed(() => {
        return formatJson(props.toolCall.arguments ?? {});
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
    const statusText = computed(() => {
        return getToolStatusText(props.toolCall.status, statusType.value);
    });
    const cardStatusClass = computed(() => {
        return getStatusClassName('tool-call-status--', statusType.value);
    });
    const fallbackBuiltinVerbText = computed(() => {
        if (props.toolCall.status === 'awaiting_approval') {
            return '等待批准';
        }

        if (props.toolCall.status === 'executing') {
            return '正在处理';
        }

        if (props.toolCall.status === 'error') {
            return '处理失败';
        }

        if (props.toolCall.status === 'rejected') {
            return '已拒绝';
        }

        if (props.toolCall.status === 'cancelled') {
            return '已取消';
        }

        return '已处理';
    });
    const builtinVerbText = computed(() => {
        return props.toolCall.builtinPresentation?.verb || fallbackBuiltinVerbText.value;
    });
    const builtinSummaryText = computed(
        () => props.toolCall.builtinPresentation?.content?.trim() || toolDisplayName.value
    );
    const builtinDurationText = computed(() => formatDurationLabel(props.toolCall.durationMs));
    const resultText = computed(() => {
        if (props.toolCall.status === 'executing') {
            return '执行中...';
        }

        if (props.toolCall.status === 'awaiting_approval') {
            return '等待用户批准后继续执行...';
        }

        const raw = props.toolCall.result?.trim();
        if (raw) {
            return raw;
        }

        if (props.toolCall.status === 'error') {
            return '无错误输出';
        }

        if (props.toolCall.status === 'rejected') {
            return '用户已拒绝此次执行';
        }

        if (props.toolCall.status === 'cancelled') {
            return '请求已取消';
        }

        return '无输出';
    });

    function formatJson(value: unknown): string {
        try {
            return JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }

    function normalizeToolToken(value?: string): string {
        return (
            value
                ?.trim()
                .toLowerCase()
                .replace(/^builtin__/, '')
                .replace(/[\s_-]+/g, '') || ''
        );
    }

    function getToolStatusText(
        status: ToolCallInfo['status'],
        statusTypeValue: 'running' | 'error' | 'completed' | 'rejected' | 'cancelled',
        options?: {
            completedText?: string;
        }
    ): string {
        if (status === 'awaiting_approval') {
            return '等待批准';
        }

        if (statusTypeValue === 'running') {
            return '运行中';
        }

        if (statusTypeValue === 'error') {
            return '失败';
        }

        if (statusTypeValue === 'rejected') {
            return '已拒绝';
        }

        if (statusTypeValue === 'cancelled') {
            return '已取消';
        }

        return options?.completedText || '完成';
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

    function formatDurationLabel(durationMs?: number): string | null {
        if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
            return null;
        }

        if (durationMs < 1000) {
            return `${Math.round(durationMs)}ms`;
        }

        const totalSeconds = Math.round(durationMs / 1000);
        if (totalSeconds < 60) {
            return `${totalSeconds}s`;
        }

        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (seconds === 0) {
            return `${minutes}m`;
        }

        return `${minutes}m ${seconds}s`;
    }

    function toggleExpanded() {
        isExpanded.value = !isExpanded.value;
    }

    function handleMouseDown(event: MouseEvent) {
        if (isBuiltinTool.value && !builtinCardComponent.value) {
            event.preventDefault();
        }
    }
</script>

<style scoped>
    .tool-call-log-wrapper {
        width: 100%;
        margin: 0.3em 0;
        cursor: default;
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-toggle {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
        padding: 0.78rem 0.8rem;
        border-radius: 0.75rem;
        border: 1px solid rgba(219, 213, 207, 0.95);
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04);
        text-align: left;
        cursor: pointer;
        transition:
            border-color 0.2s ease,
            box-shadow 0.2s ease,
            background-color 0.2s ease;
    }

    .tool-call-toggle:hover {
        border-color: rgba(219, 213, 207, 0.95);
        background: rgba(251, 251, 246, 0.95);
        box-shadow: 0 3px 10px rgba(107, 95, 84, 0.14);
    }

    .tool-call-main {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 12px;
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

    .tool-call-log-wrapper:hover .tool-call-log-line {
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

    .tool-call-log-wrapper
        :is(.tool-call-log-verb, .tool-call-log-content, .tool-call-log-duration) {
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-log-wrapper:hover .tool-call-log-content,
    .tool-call-log-wrapper:hover .tool-call-log-duration {
        color: rgb(107, 114, 128);
    }

    .tool-call-icon {
        width: 1em;
        height: 1em;
        color: var(--color-primary-600);
        flex-shrink: 0;
    }

    .tool-call-text {
        min-width: 0;
        flex: 1 1 auto;
    }

    .tool-call-title-row {
        min-width: 0;
        width: 100%;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.45rem;
    }

    .tool-call-label {
        display: block;
        min-width: 0;
        flex: 1 1 auto;
        max-width: none;
        white-space: normal;
        overflow: visible;
        text-overflow: clip;
        word-break: break-word;
        overflow-wrap: anywhere;
        font-family: var(--font-serif), serif;
        font-size: 1em;
        line-height: 1.35;
        font-weight: 600;
        color: rgb(31, 41, 55);
        user-select: none;
    }

    .tool-call-server {
        flex-shrink: 0;
        padding: 0.05rem 0.35rem;
        border-radius: 999px;
        background: var(--color-primary-100);
        color: var(--color-primary-600);
        font-size: 10px;
        line-height: 1.3;
    }

    .tool-call-meta {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        flex-shrink: 0;
    }

    .tool-call-status {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.1rem 0.45rem;
        border-radius: 999px;
        font-size: 11px;
        line-height: 1.25;
        font-weight: 500;
        border: 1px solid transparent;
    }

    .tool-call-status--running {
        background: rgba(239, 246, 255, 0.95);
        color: var(--color-info-700);
        border-color: rgba(147, 197, 253, 0.65);
    }

    .tool-call-pulse {
        display: inline-block;
        width: 0.375rem;
        height: 0.375rem;
        border-radius: 999px;
        background: var(--color-info-600);
        animation: tc-pulse 1.3s ease-in-out infinite;
    }

    .tool-call-status--error {
        background: rgba(254, 242, 242, 0.95);
        color: var(--color-error-700);
        border-color: rgba(252, 165, 165, 0.7);
    }

    .tool-call-status--completed {
        background: var(--color-primary-50);
        color: var(--color-primary-600);
        border-color: rgba(219, 213, 207, 0.95);
    }

    .tool-call-status--rejected {
        background: rgba(255, 247, 237, 0.95);
        color: rgb(154, 52, 18);
        border-color: rgba(251, 191, 36, 0.55);
    }

    .tool-call-status--cancelled {
        background: rgba(243, 244, 246, 0.95);
        color: rgb(107, 114, 128);
        border-color: rgba(209, 213, 219, 0.85);
    }

    .tool-call-duration {
        font-size: 11px;
        line-height: 1.25;
        color: rgb(107, 114, 128);
    }

    .tool-call-arrow {
        width: 0.875rem;
        height: 0.875rem;
        flex-shrink: 0;
        color: rgb(156, 163, 175);
        transition:
            transform 0.2s ease,
            color 0.2s ease;
    }

    .tool-call-toggle:hover .tool-call-arrow {
        color: rgb(107, 114, 128);
    }

    .tool-call-arrow--expanded {
        transform: rotate(90deg);
    }

    .tool-call-detail {
        margin-top: 0.45rem;
        display: flex;
        align-items: stretch;
        gap: 0.65rem;
    }

    .tool-call-section {
        flex: 1 1 0;
        border: 1px solid rgba(219, 213, 207, 0.95);
        border-radius: 0.65rem;
        background: var(--color-primary-50);
        padding: 0.65rem 0.75rem;
        min-width: 0;
    }

    .tool-call-section-title {
        margin: 0;
        font-family: var(--font-serif), serif;
        font-size: 13px;
        line-height: 1.3;
        font-weight: 600;
        color: var(--color-primary-700);
    }

    .tool-call-block {
        margin: 0.55rem 0 0;
        padding: 0;
        border: 0;
        background: transparent;
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 12px;
        line-height: 1.6;
        color: var(--color-primary-700);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 16rem;
        overflow: auto;
        scrollbar-width: thin;
        scrollbar-color: var(--color-scrollbar-thumb) transparent;
    }

    .tool-call-block::-webkit-scrollbar {
        width: 6px;
        height: 6px;
    }

    .tool-call-block::-webkit-scrollbar-track {
        background: transparent;
    }

    .tool-call-block::-webkit-scrollbar-thumb {
        background: var(--color-scrollbar-thumb);
        border-radius: 3px;
    }

    .tool-call-block::-webkit-scrollbar-thumb:hover {
        background: var(--color-scrollbar-thumb-hover);
    }

    .tool-call-block::-webkit-scrollbar-button {
        display: none;
        width: 0;
        height: 0;
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

    @media (max-width: 640px) {
        .tool-call-detail {
            flex-direction: column;
        }

        .tool-call-toggle {
            align-items: flex-start;
        }
    }

    @keyframes tc-pulse {
        0%,
        100% {
            opacity: 0.4;
        }
        50% {
            opacity: 1;
        }
    }
</style>
