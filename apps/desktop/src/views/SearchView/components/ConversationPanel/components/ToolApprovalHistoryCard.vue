<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->
<!--
  History-only renderer for tool approval cards.
  The pending state is now handled by AskUserPanel above the input bar;
  this component only shows the resolved (rejected/cancelled) badge inline
  in the message thread, so the conversation keeps a record of what happened.
-->

<template>
    <div
        v-if="isResolved"
        class="tool-approval-history-card"
        :data-approval-status="approval.status"
    >
        <div class="tool-approval-history-card__header">
            <div class="tool-approval-history-card__title-group">
                <span class="tool-approval-history-card__icon">
                    <AppIcon name="exclamation-triangle" class="h-4 w-4" />
                </span>
                <span class="tool-approval-history-card__title">
                    {{ approval.title || t('askUser.history.fallbackTitle') }}
                </span>
            </div>

            <div class="tool-approval-history-card__resolution">
                <span
                    :class="[
                        'tool-approval-history-card__resolution-badge',
                        approval.status === 'cancelled'
                            ? 'tool-approval-history-card__resolution-badge--cancelled'
                            : 'tool-approval-history-card__resolution-badge--rejected',
                    ]"
                >
                    {{
                        approval.status === 'cancelled'
                            ? t('askUser.history.cancelledBadge')
                            : t('askUser.history.rejectedBadge')
                    }}
                </span>
                <span class="tool-approval-history-card__resolution-text">
                    {{ approval.resolutionText || defaultResolutionText }}
                </span>
            </div>
        </div>

        <p v-if="approvalReasonText" class="tool-approval-history-card__description">
            {{ approvalReasonText }}
        </p>
        <pre class="tool-approval-history-card__command custom-scrollbar-thin">{{
            approval.command
        }}</pre>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { computed } from 'vue';

    import { t } from '@/i18n';
    import type { ToolApprovalInfo } from '@/types/session';

    interface Props {
        approval: ToolApprovalInfo;
    }

    const props = defineProps<Props>();

    const isResolved = computed(
        () => props.approval.status === 'rejected' || props.approval.status === 'cancelled'
    );

    const defaultResolutionText = computed(() =>
        props.approval.status === 'cancelled'
            ? t('askUser.history.cancelledText')
            : t('askUser.history.rejectedText')
    );

    const approvalReasonText = computed(
        () => props.approval.description?.trim() || props.approval.reason?.trim() || ''
    );
</script>

<style scoped>
    .tool-approval-history-card {
        border-radius: 1rem;
        border: 1px solid rgba(219, 213, 207, 0.95);
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04);
        padding: 0.95rem 1rem;
    }

    .tool-approval-history-card__header {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: center;
        flex-wrap: wrap;
    }

    .tool-approval-history-card__title-group {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-width: 0;
        flex: 1 1 18rem;
    }

    .tool-approval-history-card__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 1.9rem;
        height: 1.9rem;
        border-radius: 999px;
        background: rgba(243, 244, 246, 0.95);
        color: rgb(107, 114, 128);
        flex-shrink: 0;
    }

    .tool-approval-history-card__title {
        min-width: 0;
        font-family: var(--font-serif), serif;
        font-size: 0.95rem;
        font-weight: 600;
        line-height: 1.35;
        color: rgb(31, 41, 55);
        letter-spacing: 0.01em;
    }

    .tool-approval-history-card__description {
        margin: 0.75rem 0 0;
        font-family: var(--font-serif), serif;
        font-size: 0.84rem;
        line-height: 1.6;
        color: rgb(107, 114, 128);
    }

    .tool-approval-history-card__command {
        margin: 0.75rem 0 0;
        border-radius: 0.75rem;
        border: 1px solid rgba(229, 231, 235, 0.95);
        background: rgba(249, 250, 251, 0.9);
        padding: 0.72rem 0.8rem;
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 12px;
        line-height: 1.65;
        color: rgb(31, 41, 55);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 10rem;
        overflow: auto;
    }

    .tool-approval-history-card__resolution {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.55rem;
    }

    .tool-approval-history-card__resolution-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 0.18rem 0.55rem;
        font-size: 11px;
        line-height: 1.3;
        font-weight: 600;
    }

    .tool-approval-history-card__resolution-badge--rejected {
        background: rgba(254, 226, 226, 0.9);
        color: rgb(185, 28, 28);
    }

    .tool-approval-history-card__resolution-badge--cancelled {
        background: rgba(229, 231, 235, 0.9);
        color: rgb(75, 85, 99);
    }

    .tool-approval-history-card__resolution-text {
        color: rgb(107, 114, 128);
        font-size: 13px;
        line-height: 1.5;
    }
</style>
