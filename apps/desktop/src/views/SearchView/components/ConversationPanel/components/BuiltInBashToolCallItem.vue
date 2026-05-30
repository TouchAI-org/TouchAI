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
            <div v-if="isExpanded" class="tool-call-bash-detail">
                <div class="tool-call-bash-panel">
                    <div class="tool-call-bash-panel-header">
                        <span
                            class="tool-call-bash-shell-text"
                            :data-no-i18n="isBashShellPayload ? 'true' : undefined"
                            :translate="isBashShellPayload ? 'no' : undefined"
                        >
                            {{ bashShellText }}
                        </span>
                        <div class="tool-call-bash-panel-header-meta">
                            <span
                                v-if="bashCompressed"
                                class="tool-call-compressed-icon"
                                :title="t('conversation.toolCall.compressedOutputEnabled')"
                            >
                                <AppIcon name="leaf" class="tool-call-compressed-icon-svg" />
                            </span>
                            <span :class="['tool-call-bash-status-text', bashStatusClass]">
                                {{ bashStatusText }}
                            </span>
                            <span
                                v-if="bashDurationText"
                                class="tool-call-bash-panel-header-duration"
                                data-no-i18n="true"
                                translate="no"
                            >
                                {{ bashDurationText }}
                            </span>
                        </div>
                    </div>

                    <button
                        type="button"
                        :aria-expanded="isCommandExpanded"
                        class="tool-call-bash-command-toggle"
                        @click.stop="toggleCommandExpanded"
                    >
                        <code
                            :class="
                                isCommandExpanded
                                    ? 'tool-call-bash-command tool-call-bash-command--expanded'
                                    : 'tool-call-bash-command tool-call-bash-command--collapsed'
                            "
                        >
                            <span class="tool-call-bash-prompt">$</span>
                            <template v-for="token in bashCommandTokens" :key="token.key">
                                <span
                                    :class="[
                                        'tool-call-bash-token',
                                        `tool-call-bash-token--${token.kind}`,
                                    ]"
                                    :data-no-i18n="isBashCommandPayload ? 'true' : undefined"
                                    :translate="isBashCommandPayload ? 'no' : undefined"
                                >
                                    {{ token.text }}
                                </span>
                            </template>
                        </code>
                    </button>

                    <div class="tool-call-bash-output-block">
                        <pre
                            :class="
                                hasBashOutput
                                    ? 'tool-call-bash-output custom-scrollbar-thin'
                                    : 'tool-call-bash-output tool-call-bash-output--empty custom-scrollbar-thin'
                            "
                            :data-no-i18n="hasBashOutput ? 'true' : undefined"
                            :translate="hasBashOutput ? 'no' : undefined"
                            v-text="bashOutputText"
                        ></pre>
                    </div>
                </div>
            </div>
        </transition>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';
    import {
        isEmptyBashOutputText,
        parseBashToolResult,
    } from '@/services/BuiltInToolService/tools/bash/helper';
    import type { ToolCallInfo } from '@/types/session';

    const ROOT_CLASS =
        'tool-call-bash-wrapper tool-call-log-wrapper paragraph-node touchai-markdown touchai-markdown--default';

    type BashCommandTokenKind =
        | 'space'
        | 'command'
        | 'flag'
        | 'string'
        | 'variable'
        | 'operator'
        | 'path'
        | 'plain';

    interface BashCommandToken {
        key: string;
        text: string;
        kind: BashCommandTokenKind;
    }

    interface Props {
        toolCall: ToolCallInfo;
        verbText: string;
        summaryText: string;
        durationText?: string | null;
    }

    const props = defineProps<Props>();

    const isExpanded = ref(false);
    const isCommandExpanded = ref(false);
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
    const bashResultMeta = computed(() => parseBashToolResult(props.toolCall.result));
    const bashCompressed = computed(() => bashResultMeta.value.compressed);
    const bashCommandText = computed(() => {
        return (
            normalizeInlineText(props.toolCall.arguments?.command) ||
            props.summaryText ||
            t('conversation.toolCall.commandFallback')
        );
    });
    const isBashCommandPayload = computed(() => {
        return Boolean(normalizeInlineText(props.toolCall.arguments?.command) || props.summaryText);
    });
    const bashDurationText = computed(
        () => props.durationText || bashResultMeta.value.duration || null
    );
    const bashShellText = computed(() => bashResultMeta.value.shell || 'PowerShell');
    const isBashShellPayload = computed(() => Boolean(bashResultMeta.value.shell));
    const bashOutputText = computed(() => {
        if (props.toolCall.status === 'awaiting_approval') {
            return t('conversation.toolCall.waitingUserApproval');
        }

        if (props.toolCall.status === 'executing') {
            return t('conversation.toolCall.commandRunning');
        }

        if (props.toolCall.status === 'rejected') {
            return t('conversation.toolCall.userRejected');
        }

        if (props.toolCall.status === 'cancelled') {
            return t('conversation.toolCall.commandCancelled');
        }

        const output = bashResultMeta.value.output?.trim();
        if (!isEmptyBashOutputText(output)) {
            return output;
        }

        if (props.toolCall.status === 'error') {
            return t('conversation.toolCall.noErrorOutput');
        }

        return t('conversation.toolCall.noOutput');
    });
    const hasBashOutput = computed(() => {
        const output = bashResultMeta.value.output?.trim();
        return !isEmptyBashOutputText(output);
    });
    const bashCommandTokens = computed(() => tokenizeBashCommand(bashCommandText.value));
    const bashStatusClass = computed(() => {
        return getStatusClassName('tool-call-bash-status--', statusType.value);
    });
    const bashStatusText = computed(() => {
        return getToolStatusText(props.toolCall.status, statusType.value);
    });

    function normalizeInlineText(value: unknown): string | null {
        if (typeof value !== 'string') {
            return null;
        }

        const trimmed = value.trim();
        return trimmed || null;
    }

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
        if (!isExpanded.value) {
            isCommandExpanded.value = false;
        }
    }

    function toggleCommandExpanded() {
        isCommandExpanded.value = !isCommandExpanded.value;
    }

    function tokenizeBashCommand(command: string): BashCommandToken[] {
        const segments = command.match(
            /(\r?\n|\s+|&&|\|\||\|>|2>>|2>|1>>|1>|>>|[|;<>()[\]{}]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\$\{[^}]+\}|\$[A-Za-z_][\w.:-]*|-[A-Za-z0-9][\w-]*|[^\s|;<>()[\]{}]+)/g
        ) ?? [command];
        const tokens: BashCommandToken[] = [];
        let didMarkCommand = false;

        for (const segment of segments) {
            if (/^\s+$/.test(segment)) {
                pushBashCommandToken(tokens, segment, 'space');
                continue;
            }

            if (/^(?:&&|\|\||\|>|2>>|2>|1>>|1>|>>|[|;<>()[\]{}])$/.test(segment)) {
                pushBashCommandToken(tokens, segment, 'operator');
                continue;
            }

            if (/^['"]/.test(segment) || /^@['"]/.test(segment)) {
                pushBashCommandToken(tokens, segment, 'string');
                continue;
            }

            if (/^\$\{[^}]+\}$/.test(segment) || /^\$[A-Za-z_][\w.:-]*$/.test(segment)) {
                pushBashCommandToken(tokens, segment, 'variable');
                continue;
            }

            if (/^-{1,2}[A-Za-z0-9][\w-]*$/.test(segment)) {
                pushBashCommandToken(tokens, segment, 'flag');
                continue;
            }

            if (!didMarkCommand) {
                pushBashCommandToken(tokens, segment, 'command');
                didMarkCommand = true;
                continue;
            }

            if (looksLikePath(segment)) {
                pushBashCommandToken(tokens, segment, 'path');
                continue;
            }

            pushBashCommandToken(tokens, segment, 'plain');
        }

        return tokens;
    }

    function pushBashCommandToken(
        tokens: BashCommandToken[],
        text: string,
        kind: BashCommandTokenKind
    ) {
        tokens.push({
            key: `${tokens.length}-${kind}-${text}`,
            text,
            kind,
        });
    }

    function looksLikePath(token: string): boolean {
        return (
            /^[A-Za-z]:[\\/]/.test(token) ||
            /^[.~]{1,2}[\\/]/.test(token) ||
            token.includes('\\') ||
            token.includes('/')
        );
    }
</script>

<style scoped>
    .tool-call-bash-wrapper {
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

    .tool-call-bash-wrapper:hover .tool-call-log-line {
        color: rgb(75, 85, 99);
    }

    .tool-call-log-verb {
        color: inherit;
        font-size: 0.9em;
    }

    .tool-call-compressed-icon {
        display: inline-flex;
        align-items: center;
        margin-right: 0.3rem;
        color: var(--color-primary-400);

        .tool-call-compressed-icon-svg {
            width: 0.85em;
            height: 0.85em;
        }
    }

    .tool-call-log-content,
    .tool-call-log-duration {
        color: rgb(156, 163, 175);
        font-size: 0.9em;
        transition: color 0.16s ease;
    }

    .tool-call-bash-wrapper
        :is(.tool-call-log-verb, .tool-call-log-content, .tool-call-log-duration) {
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-bash-wrapper:hover .tool-call-log-content,
    .tool-call-bash-wrapper:hover .tool-call-log-duration {
        color: rgb(107, 114, 128);
    }

    .tool-call-bash-detail {
        margin-top: 0.68rem;
    }

    .tool-call-bash-panel {
        border-radius: 0.72rem;
        border: 1px solid rgb(235, 231, 227);
        background: transparent;
        box-shadow: 0 1px 2px rgba(107, 114, 128, 0.04);
        padding: 0.72rem 0.78rem;
    }

    .tool-call-bash-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.55rem;
        flex-wrap: wrap;
    }

    .tool-call-bash-shell-text {
        display: block;
        color: rgb(107, 114, 128);
        font-size: 10px;
        line-height: 1.3;
        font-weight: 500;
        letter-spacing: 0.02em;
        text-transform: lowercase;
    }

    .tool-call-bash-panel-header-meta {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
        flex-wrap: wrap;
        text-align: right;
        margin-left: auto;
    }

    .tool-call-bash-panel-header-duration {
        font-size: 10px;
        line-height: 1.3;
        color: rgb(128, 121, 113);
    }

    .tool-call-bash-command-toggle,
    .tool-call-bash-output-block {
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

    .tool-call-bash-command-toggle {
        cursor: pointer;
    }

    .tool-call-bash-command-toggle:focus-visible {
        outline: none;
    }

    .tool-call-bash-command-toggle:focus-visible .tool-call-bash-command {
        outline: 1px solid rgba(184, 175, 165, 0.75);
        outline-offset: 2px;
        border-radius: 0.35rem;
    }

    .tool-call-bash-command {
        display: block;
        margin: 0;
        padding: 0;
        overflow-x: auto;
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 11.5px;
        line-height: 1.65;
        white-space: pre-wrap;
        word-break: break-word;
        color: rgb(48, 44, 40);
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-bash-command--collapsed {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .tool-call-bash-command--expanded {
        white-space: pre-wrap;
    }

    .tool-call-bash-command::-webkit-scrollbar {
        width: 6px;
        height: 6px;
    }

    .tool-call-bash-command::-webkit-scrollbar-track {
        background: transparent;
    }

    .tool-call-bash-command::-webkit-scrollbar-thumb {
        background: var(--color-scrollbar-thumb);
        border-radius: 3px;
    }

    .tool-call-bash-prompt {
        margin-right: 0.35ch;
        color: rgb(128, 121, 113);
    }

    .tool-call-bash-token--command {
        color: rgb(54, 47, 42);
        font-weight: 700;
    }

    .tool-call-bash-token--flag {
        color: rgb(118, 92, 64);
    }

    .tool-call-bash-token--string {
        color: rgb(86, 110, 71);
    }

    .tool-call-bash-token--variable {
        color: rgb(95, 112, 136);
    }

    .tool-call-bash-token--operator {
        color: rgb(158, 150, 141);
    }

    .tool-call-bash-token--path {
        color: rgb(124, 88, 60);
    }

    .tool-call-bash-token--plain {
        color: rgb(90, 86, 81);
    }

    .tool-call-bash-output {
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
        user-select: none;
        -webkit-user-select: none;
        -moz-user-select: none;
        -ms-user-select: none;
    }

    .tool-call-bash-output--empty {
        color: rgb(157, 149, 140);
    }

    .tool-call-bash-status-text {
        display: inline-block;
        font-size: 10px;
        line-height: 1.3;
        font-weight: 500;
        color: rgb(102, 96, 89);
    }

    .tool-call-bash-status--running {
        color: rgb(92, 104, 119);
    }

    .tool-call-bash-status--completed {
        color: rgb(102, 96, 89);
    }

    .tool-call-bash-status--cancelled {
        color: rgb(128, 122, 115);
    }

    .tool-call-bash-status--error,
    .tool-call-bash-status--rejected {
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
