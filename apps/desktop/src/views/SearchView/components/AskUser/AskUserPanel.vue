<!--
  AskUserPanel - top-level shell for the unified "ask user" UI.
  Placed in document flow between ConversationPanel and the input bar.
  All three kinds (approval / confirm / question) feed through AskUserQuestions
  so animations, proximity hover, focus, and keyboard routing are shared.
-->

<template>
    <AnimatePresence>
        <motion.div
            v-if="current"
            :key="current.id"
            class="ask-user-panel w-full flex-shrink-0"
            :initial="{ height: 0, opacity: 0 }"
            :animate="{ height: 'auto', opacity: 1 }"
            :exit="{ height: 0, opacity: 0 }"
            :transition="springs.slow"
        >
            <AskUserQuestions
                ref="questionsBodyRef"
                :questions="mappedQuestions"
                :answers="controlledAnswers"
                @update:answers="controlledAnswers = $event"
                @complete="handleComplete"
                @skip="handleSkip"
                @cancel="handleCancel"
            />
        </motion.div>
    </AnimatePresence>
</template>

<script setup lang="ts">
    import './styles/tokens.css';

    import { AnimatePresence, motion } from 'motion-v';
    import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

    import type { AskUserAnswer as StoreAnswer } from '@/contracts/tooling';
    import { t } from '@/i18n';
    import {
        type AskUserApprovalRequest,
        type AskUserConfirmRequest,
        type AskUserQuestionRequest,
        useAskUserStore,
    } from '@/stores/askUser';

    import type { AskUserAnswer, AskUserQuestion } from './AskUserQuestions.vue';
    import AskUserQuestions from './AskUserQuestions.vue';
    import { springs } from './lib/springs';

    const store = useAskUserStore();
    const current = computed(() => store.current);

    const questionsBodyRef = ref<InstanceType<typeof AskUserQuestions> | null>(null);

    // Controlled answers — used to inject "selected by arming delay" disabled state for approval.
    const controlledAnswers = ref<Record<string, AskUserAnswer>>({});

    // 450ms keyboard arm delay for approval kind (prevents accidental Enter).
    const approvalArmed = ref(true);
    let armTimer: ReturnType<typeof setTimeout> | null = null;

    function clearArmTimer(): void {
        if (armTimer) {
            clearTimeout(armTimer);
            armTimer = null;
        }
    }

    function startArmTimer(delayMs: number): void {
        clearArmTimer();
        if (delayMs > 0) {
            approvalArmed.value = false;
            armTimer = setTimeout(() => {
                approvalArmed.value = true;
            }, delayMs);
        } else {
            approvalArmed.value = true;
        }
    }

    // Map current request into a single AskUserQuestion the AskUserQuestions component understands.
    const mappedQuestions = computed<AskUserQuestion[]>(() => {
        const req = current.value;
        if (!req) return [];

        if (req.kind === 'approval') {
            const approval = (req as AskUserApprovalRequest).payload;
            return [
                {
                    id: 'approval',
                    title: approval.title || t('askUser.approval.fallbackTitle'),
                    subtitle: approval.description?.trim() || approval.reason?.trim() || undefined,
                    commandPreview: approval.command,
                    layout: 'inline',
                    skippable: false,
                    options: [
                        {
                            id: 'approve',
                            title: approval.approveLabel || t('askUser.approval.approve'),
                            disabled: !approvalArmed.value,
                        },
                        {
                            id: 'reject',
                            title: approval.rejectLabel || t('askUser.approval.reject'),
                        },
                    ],
                },
            ];
        }

        if (req.kind === 'confirm') {
            const opts = (req as AskUserConfirmRequest).options;
            return [
                {
                    id: 'confirm',
                    title: opts.title || t('askUser.confirm.fallbackTitle'),
                    subtitle: opts.message || undefined,
                    layout: 'inline',
                    skippable: false,
                    options: [
                        { id: 'ok', title: opts.confirmText || t('askUser.confirm.confirm') },
                        { id: 'cancel', title: opts.cancelText || t('askUser.confirm.cancel') },
                    ],
                },
            ];
        }

        // question
        const qReq = req as AskUserQuestionRequest;
        return qReq.questions.map((q, i) => ({
            id: `q-${i}`,
            title: q.question,
            options: q.options.map((opt) => ({
                title: opt.label,
                description: opt.description,
            })),
            multiSelect: q.multiSelect,
            allowOther: q.allowOther ?? false,
            skippable: true,
            layout: 'stacked' as const,
        }));
    });

    // Handle completion — route per kind.
    function handleComplete(answers: Record<string, AskUserAnswer>): void {
        const req = current.value;
        if (!req) return;

        if (req.kind === 'approval') {
            const ans = answers['approval'];
            const approved = ans?.selectedIds.includes('approve') ?? false;
            if (approved) store.approveCurrentApproval();
            else store.rejectCurrentApproval();
            return;
        }

        if (req.kind === 'confirm') {
            const ans = answers['confirm'];
            const ok = ans?.selectedIds.includes('ok') ?? false;
            if (ok) store.confirmCurrentConfirm();
            else store.cancelCurrentConfirm();
            return;
        }

        // question
        const qReq = req as AskUserQuestionRequest;
        const storeAnswers: StoreAnswer[] = qReq.questions.map((_, i) => {
            const qKey = `q-${i}`;
            const a = answers[qKey];
            if (!a || a.skipped) {
                return { questionIndex: i, selectedLabels: [], skipped: true };
            }
            const selectedLabels = a.selectedIds.map((id) => {
                const optIndex = parseInt(id.replace('o-', ''), 10);
                return qReq.questions[i]?.options[optIndex]?.label ?? id;
            });
            return {
                questionIndex: i,
                selectedLabels,
                otherText: a.otherText?.trim() || undefined,
                skipped: false,
            };
        });
        store.answerCurrentQuestion(storeAnswers);
    }

    function handleSkip(): void {
        // No-op — the question pipeline already records the skipped answer
        // and advances. Final completion is handled in handleComplete.
    }

    function handleCancel(): void {
        const req = current.value;
        if (!req) return;
        if (req.kind === 'approval') {
            store.rejectCurrentApproval();
        } else if (req.kind === 'confirm') {
            store.cancelCurrentConfirm();
        } else {
            store.cancelCurrentQuestion();
        }
    }

    // Reset controlled answers + arm timer whenever the current request changes.
    watch(
        () => current.value?.id,
        (id) => {
            controlledAnswers.value = {};
            clearArmTimer();
            if (!id) return;
            const req = current.value;
            if (req?.kind === 'approval') {
                const delayMs =
                    (req as AskUserApprovalRequest).payload.keyboardApproveDelayMs ?? 450;
                startArmTimer(delayMs);
            } else {
                approvalArmed.value = true;
            }
            // Focus first row once mounted.
            nextTick(() => {
                nextTick(() => focusFirstRow());
            });
        },
        { immediate: true }
    );

    function focusFirstRow(): void {
        const root = (questionsBodyRef.value as { rootRef?: HTMLElement } | null)?.rootRef;
        if (!root) return;
        const firstRow = root.querySelector('[data-proximity-index="0"]') as HTMLElement | null;
        if (firstRow) {
            firstRow.focus();
        } else {
            root.focus();
        }
    }

    onMounted(() => {
        // nothing — focus handled by watch above
    });

    onUnmounted(() => {
        clearArmTimer();
    });
</script>
