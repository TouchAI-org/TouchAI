<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="tool-approval-card" :data-approval-status="approval.status">
        <div class="tool-approval-card__header">
            <div class="tool-approval-card__title-group">
                <span class="tool-approval-card__icon">
                    <AppIcon name="exclamation-triangle" class="h-4 w-4" />
                </span>
                <span
                    class="tool-approval-card__title"
                    :data-no-i18n="isApprovalTitlePayload ? 'true' : undefined"
                    :translate="isApprovalTitlePayload ? 'no' : undefined"
                >
                    {{ approvalTitleText }}
                </span>
            </div>

            <div v-if="approval.status === 'pending'" class="tool-approval-card__actions">
                <button
                    type="button"
                    :class="[
                        'tool-approval-card__button',
                        'tool-approval-card__button--approve',
                        isAttentionActive ? 'tool-approval-card__button--attention' : '',
                    ]"
                    @click="emit('approve', approval.callId)"
                >
                    <span
                        :data-no-i18n="isApproveLabelPayload ? 'true' : undefined"
                        :translate="isApproveLabelPayload ? 'no' : undefined"
                    >
                        {{ approveLabelText }}
                    </span>
                    <span
                        :class="
                            isKeyboardArmed
                                ? 'tool-approval-card__keycap'
                                : 'tool-approval-card__keycap tool-approval-card__keycap--locked'
                        "
                        :data-no-i18n="isEnterHintPayload ? 'true' : undefined"
                        :translate="isEnterHintPayload ? 'no' : undefined"
                    >
                        {{ enterHintText }}
                    </span>
                </button>
                <button
                    type="button"
                    class="tool-approval-card__button tool-approval-card__button--reject"
                    @click="emit('reject', approval.callId)"
                >
                    <span
                        :data-no-i18n="isRejectLabelPayload ? 'true' : undefined"
                        :translate="isRejectLabelPayload ? 'no' : undefined"
                    >
                        {{ rejectLabelText }}
                    </span>
                    <span
                        class="tool-approval-card__keycap"
                        :data-no-i18n="isEscHintPayload ? 'true' : undefined"
                        :translate="isEscHintPayload ? 'no' : undefined"
                    >
                        {{ escHintText }}
                    </span>
                </button>
            </div>

            <div v-else class="tool-approval-card__resolution">
                <span
                    :class="[
                        'tool-approval-card__resolution-badge',
                        approval.status === 'cancelled'
                            ? 'tool-approval-card__resolution-badge--cancelled'
                            : 'tool-approval-card__resolution-badge--rejected',
                    ]"
                >
                    {{
                        approval.status === 'cancelled'
                            ? t('common.cancelled')
                            : t('common.rejected')
                    }}
                </span>
                <span
                    class="tool-approval-card__resolution-text"
                    :data-no-i18n="isResolutionTextPayload ? 'true' : undefined"
                    :translate="isResolutionTextPayload ? 'no' : undefined"
                >
                    {{ resolutionText }}
                </span>
            </div>
        </div>

        <p
            v-if="approvalReasonText"
            class="tool-approval-card__description"
            :data-no-i18n="isApprovalReasonPayload ? 'true' : undefined"
            :translate="isApprovalReasonPayload ? 'no' : undefined"
        >
            {{ approvalReasonText }}
        </p>
        <pre
            class="tool-approval-card__command custom-scrollbar-thin"
            data-no-i18n="true"
            translate="no"
            v-text="approval.command"
        ></pre>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import { t, type MessageKey } from '@/i18n';
    import type { ToolApprovalInfo } from '@/types/session';

    interface Props {
        approval: ToolApprovalInfo;
        attentionToken?: number;
    }

    const props = withDefaults(defineProps<Props>(), {
        attentionToken: 0,
    });

    const emit = defineEmits<{
        approve: [callId: string];
        reject: [callId: string];
    }>();

    const isKeyboardArmed = ref(true);
    const isAttentionActive = ref(false);
    let keyboardArmTimer: ReturnType<typeof setTimeout> | null = null;
    let attentionTimer: ReturnType<typeof setTimeout> | null = null;
    let attentionFrame: number | null = null;

    const APP_OWNED_APPROVAL_TEXT_KEYS: Record<string, MessageKey> = {
        需要确认: 'conversation.approval.defaultTitle',
        命令执行确认: 'conversation.approval.commandExecutionTitle',
        读取本地内容确认: 'conversation.approval.readLocalContentTitle',
        模型切换确认: 'conversation.approval.modelSwitchTitle',
        设置修改确认: 'conversation.approval.settingChangeTitle',
        命令执行需要确认: 'conversation.approval.commandExecutionNeedsConfirmation',
        '这是一个高风险命令，请确认后再继续执行。':
            'conversation.approval.highRiskCommandDescription',
        高风险: 'conversation.approval.highRiskLabel',
        '命令可能修改文件或系统状态。': 'conversation.approval.modifiesFilesOrSystemState',
        命令预览: 'conversation.approval.commandPreview',
        批准执行: 'conversation.approval.approveExecute',
        拒绝执行: 'conversation.approval.rejectExecute',
        'Enter 批准': 'conversation.approval.enterApprove',
        'Esc 拒绝': 'conversation.approval.escReject',
        批准: 'conversation.approval.approve',
        拒绝: 'conversation.approval.reject',
        已批准执行此命令: 'conversation.approval.approvedCommand',
        已拒绝执行此命令: 'conversation.approval.rejectedCommand',
        用户已拒绝执行此命令: 'conversation.approval.userRejectedCommand',
        本次命令已取消: 'conversation.approval.commandCancelled',
        本次命令未被执行: 'conversation.approval.commandNotExecuted',
        请求已取消: 'common.requestCancelled',
        '当前配置要求所有 Bash 命令都必须先批准。':
            'conversation.approval.bashApprovalRequired',
        '命令可能删除文件或目录。': 'conversation.approval.mayDeleteFiles',
        '命令可能重置或清理 Git 工作区。': 'conversation.approval.mayResetGitWorktree',
        '命令可能修改或覆盖文件内容。': 'conversation.approval.mayModifyFiles',
        '命令包含输出重定向，可能覆写文件。':
            'conversation.approval.mayOverwriteViaRedirection',
        '命令可能修改系统配置或影响设备状态。': 'conversation.approval.mayModifySystem',
        '此操作会读取本地文件或目录内容，并将结果发送给模型。':
            'conversation.approval.readLocalContentDescription',
        '这会修改当前问答后续使用的模型，并同步影响后续默认模型。':
            'conversation.approval.modelSwitchSettingDescription',
        '此操作会修改 TouchAI 的应用设置，并立即影响后续行为。':
            'conversation.approval.appSettingsChangeDescription',
    };
    const MODEL_SWITCH_TEXT_PATTERN = /^允许从 (.+) 切换到 (.+)$/;

    function normalizeInlineText(value?: string | null): string {
        return value?.trim() || '';
    }

    function isAppOwnedApprovalText(value: string): boolean {
        return Boolean(APP_OWNED_APPROVAL_TEXT_KEYS[value.trim()]);
    }

    function getModelSwitchParams(
        value: string
    ): { currentModel: string; targetModel: string } | null {
        const match = MODEL_SWITCH_TEXT_PATTERN.exec(value.trim());
        if (!match?.[1] || !match[2]) {
            return null;
        }

        return {
            currentModel: match[1],
            targetModel: match[2],
        };
    }

    function translateAppOwnedText(value: string): string {
        const modelSwitchParams = getModelSwitchParams(value);
        if (modelSwitchParams) {
            return t('conversation.approval.modelSwitchDescription', modelSwitchParams);
        }

        const key = APP_OWNED_APPROVAL_TEXT_KEYS[value.trim()];
        return key ? t(key) : value;
    }

    const defaultResolutionText = computed(() => {
        return props.approval.status === 'cancelled'
            ? t('conversation.approval.commandCancelled')
            : t('conversation.approval.commandNotExecuted');
    });
    const approvalTitleSourceText = computed(
        () => normalizeInlineText(props.approval.title) || '需要确认'
    );
    const isApprovalTitlePayload = computed(
        () => !isAppOwnedApprovalText(approvalTitleSourceText.value)
    );
    const approvalTitleText = computed(() => translateAppOwnedText(approvalTitleSourceText.value));
    const approvalReasonSourceText = computed(() => {
        return (
            normalizeInlineText(props.approval.description) ||
            normalizeInlineText(props.approval.reason)
        );
    });
    const isApprovalReasonPayload = computed(
        () =>
            Boolean(approvalReasonSourceText.value) &&
            !isAppOwnedApprovalText(approvalReasonSourceText.value) &&
            !getModelSwitchParams(approvalReasonSourceText.value)
    );
    const approvalReasonText = computed(() => {
        return translateAppOwnedText(approvalReasonSourceText.value);
    });
    const approveLabelSourceText = computed(
        () => normalizeInlineText(props.approval.approveLabel) || '批准执行'
    );
    const isApproveLabelPayload = computed(
        () => !isAppOwnedApprovalText(approveLabelSourceText.value)
    );
    const approveLabelText = computed(() => translateAppOwnedText(approveLabelSourceText.value));
    const rejectLabelSourceText = computed(
        () => normalizeInlineText(props.approval.rejectLabel) || '拒绝执行'
    );
    const isRejectLabelPayload = computed(
        () => !isAppOwnedApprovalText(rejectLabelSourceText.value)
    );
    const rejectLabelText = computed(() => translateAppOwnedText(rejectLabelSourceText.value));
    const enterHintSourceText = computed(
        () => normalizeInlineText(props.approval.enterHint) || 'Enter'
    );
    const isEnterHintPayload = computed(
        () =>
            !['Enter', 'Esc'].includes(enterHintSourceText.value) &&
            !isAppOwnedApprovalText(enterHintSourceText.value)
    );
    const enterHintText = computed(() => translateAppOwnedText(enterHintSourceText.value));
    const escHintSourceText = computed(() => normalizeInlineText(props.approval.escHint) || 'Esc');
    const isEscHintPayload = computed(
        () =>
            !['Enter', 'Esc'].includes(escHintSourceText.value) &&
            !isAppOwnedApprovalText(escHintSourceText.value)
    );
    const escHintText = computed(() => translateAppOwnedText(escHintSourceText.value));
    const resolutionSourceText = computed(() => normalizeInlineText(props.approval.resolutionText));
    const isResolutionTextPayload = computed(
        () =>
            Boolean(resolutionSourceText.value) &&
            !isAppOwnedApprovalText(resolutionSourceText.value) &&
            !getModelSwitchParams(resolutionSourceText.value)
    );
    const resolutionText = computed(() => {
        return resolutionSourceText.value
            ? translateAppOwnedText(resolutionSourceText.value)
            : defaultResolutionText.value;
    });

    /**
     * 通过触发一次 CSS animation，把用户被拦截的输入尝试转换成
     * 对批准按钮的明确视觉引导。
     */
    function triggerAttentionShake() {
        if (props.approval.status !== 'pending') {
            return;
        }

        isAttentionActive.value = false;
        if (attentionTimer) {
            clearTimeout(attentionTimer);
            attentionTimer = null;
        }
        if (attentionFrame) {
            cancelAnimationFrame(attentionFrame);
            attentionFrame = null;
        }

        attentionFrame = requestAnimationFrame(() => {
            attentionFrame = requestAnimationFrame(() => {
                isAttentionActive.value = true;
                attentionTimer = setTimeout(() => {
                    isAttentionActive.value = false;
                    attentionTimer = null;
                }, 560);
            });
        });
    }

    onMounted(() => {
        if (props.approval.status !== 'pending') {
            return;
        }

        const remaining = props.approval.keyboardApproveAt - Date.now();
        if (remaining > 0) {
            isKeyboardArmed.value = false;
            keyboardArmTimer = setTimeout(() => {
                isKeyboardArmed.value = true;
            }, remaining);
        } else {
            isKeyboardArmed.value = true;
        }
    });

    watch(
        () => props.attentionToken,
        (nextToken, previousToken) => {
            if (!nextToken || nextToken === previousToken) {
                return;
            }

            triggerAttentionShake();
        }
    );

    onUnmounted(() => {
        if (keyboardArmTimer) {
            clearTimeout(keyboardArmTimer);
            keyboardArmTimer = null;
        }
        if (attentionTimer) {
            clearTimeout(attentionTimer);
            attentionTimer = null;
        }
        if (attentionFrame) {
            cancelAnimationFrame(attentionFrame);
            attentionFrame = null;
        }
    });
</script>

<style scoped>
    .tool-approval-card {
        border-radius: 1rem;
        border: 1px solid rgba(219, 213, 207, 0.95);
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 1px 2px rgba(17, 24, 39, 0.04);
        padding: 0.95rem 1rem;
    }

    .tool-approval-card__header {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: center;
        flex-wrap: wrap;
    }

    .tool-approval-card__title-group {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        min-width: 0;
        flex: 1 1 18rem;
    }

    .tool-approval-card__icon {
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

    .tool-approval-card__title {
        min-width: 0;
        font-family: var(--font-serif), serif;
        font-size: 0.95rem;
        font-weight: 600;
        line-height: 1.35;
        color: rgb(31, 41, 55);
        letter-spacing: 0.01em;
    }

    .tool-approval-card__description {
        margin: 0.75rem 0 0;
        font-family: var(--font-serif), serif;
        font-size: 0.84rem;
        line-height: 1.6;
        color: rgb(107, 114, 128);
    }

    .tool-approval-card__command {
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

    .tool-approval-card__actions {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        flex: 0 0 auto;
    }

    .tool-approval-card__button {
        border: 1px solid rgba(229, 231, 235, 0.95);
        border-radius: 0.75rem;
        padding: 0.55rem 0.7rem;
        font-size: 12px;
        line-height: 1.3;
        font-weight: 600;
        cursor: pointer;
        transition:
            transform 0.18s ease,
            box-shadow 0.18s ease,
            background-color 0.18s ease;
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
    }

    .tool-approval-card__button:hover {
        transform: translateY(-1px);
    }

    .tool-approval-card__button--approve {
        background: var(--color-primary-700);
        color: white;
        border-color: var(--color-primary-700);
        box-shadow: 0 6px 16px rgba(90, 79, 69, 0.16);
    }

    .tool-approval-card__button--approve:hover {
        background: var(--color-primary-600);
        border-color: var(--color-primary-600);
    }

    .tool-approval-card__button--reject {
        background: var(--color-primary-50);
        color: var(--color-primary-600);
        border-color: var(--color-primary-200);
    }

    .tool-approval-card__button--reject:hover {
        background: var(--color-primary-100);
        border-color: var(--color-primary-300);
    }

    .tool-approval-card__keycap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0.1rem 0.35rem;
        border-radius: 0.4rem;
        border: 1px solid rgba(229, 231, 235, 0.95);
        background: rgba(255, 255, 255, 0.22);
        font-size: 11px;
        line-height: 1.2;
        font-weight: 700;
        letter-spacing: 0.03em;
    }

    .tool-approval-card__button--attention {
        animation: tool-approval-shake 0.52s ease;
    }

    .tool-approval-card__keycap--locked {
        opacity: 0.45;
    }

    .tool-approval-card__resolution {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.55rem;
    }

    .tool-approval-card__resolution-badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 0.18rem 0.55rem;
        font-size: 11px;
        line-height: 1.3;
        font-weight: 600;
    }

    .tool-approval-card__resolution-badge--approved {
        background: rgba(220, 252, 231, 0.9);
        color: rgb(21, 128, 61);
    }

    .tool-approval-card__resolution-badge--rejected {
        background: rgba(254, 226, 226, 0.9);
        color: rgb(185, 28, 28);
    }

    .tool-approval-card__resolution-badge--cancelled {
        background: rgba(229, 231, 235, 0.9);
        color: rgb(75, 85, 99);
    }

    .tool-approval-card__resolution-text {
        color: rgb(107, 114, 128);
        font-size: 13px;
        line-height: 1.5;
    }

    @keyframes tool-approval-shake {
        0%,
        100% {
            transform: translateX(0);
        }
        20% {
            transform: translateX(-3px);
        }
        40% {
            transform: translateX(3px);
        }
        60% {
            transform: translateX(-2px);
        }
        80% {
            transform: translateX(2px);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .tool-approval-card__button--attention,
        .tool-approval-card__button:hover {
            animation: none;
            transform: none;
        }
    }
</style>
