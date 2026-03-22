<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="tool-approval-card mt-[0.9rem]" :data-approval-status="approval.status">
        <div class="tool-approval-card__header">
            <div class="tool-approval-card__title-group">
                <span class="tool-approval-card__icon">
                    <SvgIcon name="exclamation-triangle" class="h-4 w-4" />
                </span>
                <span class="tool-approval-card__title">
                    {{ approval.title || '需要确认' }}
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
                    <span>{{ approval.approveLabel }}</span>
                    <span
                        :class="
                            isKeyboardArmed
                                ? 'tool-approval-card__keycap'
                                : 'tool-approval-card__keycap tool-approval-card__keycap--locked'
                        "
                    >
                        {{ approval.enterHint || 'Enter' }}
                    </span>
                </button>
                <button
                    type="button"
                    class="tool-approval-card__button tool-approval-card__button--reject"
                    @click="emit('reject', approval.callId)"
                >
                    <span>{{ approval.rejectLabel }}</span>
                    <span class="tool-approval-card__keycap">
                        {{ approval.escHint || 'Esc' }}
                    </span>
                </button>
            </div>

            <div v-else class="tool-approval-card__resolution">
                <span
                    class="tool-approval-card__resolution-badge tool-approval-card__resolution-badge--rejected"
                >
                    已拒绝
                </span>
                <span class="tool-approval-card__resolution-text">
                    {{ approval.resolutionText || defaultResolutionText }}
                </span>
            </div>
        </div>

        <p v-if="approvalReasonText" class="tool-approval-card__description">
            {{ approvalReasonText }}
        </p>
        <pre class="tool-approval-card__command custom-scrollbar-thin">{{ approval.command }}</pre>
    </div>
</template>

<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

    import type { ToolApprovalInfo } from '@/types/conversation';

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
    const defaultResolutionText = computed(() => {
        return '本次命令未被执行';
    });
    const approvalReasonText = computed(() => {
        return props.approval.description?.trim() || props.approval.reason?.trim() || '';
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
