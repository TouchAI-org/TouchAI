// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type {
    AskUserAnswer,
    AskUserQuestion,
    ToolApprovalDecisionRequest,
} from '@/services/AgentService/contracts/tooling';

export type AskUserKind = 'approval' | 'confirm' | 'question';

export interface AskUserConfirmOptions {
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    type?: 'warning' | 'danger' | 'info';
}

interface AskUserBaseRequest {
    id: string;
    createdAt: number;
}

export interface AskUserApprovalRequest extends AskUserBaseRequest {
    kind: 'approval';
    payload: ToolApprovalDecisionRequest;
}

export interface AskUserConfirmRequest extends AskUserBaseRequest {
    kind: 'confirm';
    options: AskUserConfirmOptions;
}

export interface AskUserQuestionRequest extends AskUserBaseRequest {
    kind: 'question';
    questions: AskUserQuestion[];
    sourceCallId?: string;
}

export type AskUserRequest =
    | AskUserApprovalRequest
    | AskUserConfirmRequest
    | AskUserQuestionRequest;

type ApprovalResolver = (approved: boolean, resolutionText?: string) => void;
type ConfirmResolver = (confirmed: boolean) => void;
type QuestionResolver = (answers: AskUserAnswer[] | null) => void;

type ResolverEntry =
    | { kind: 'approval'; resolve: ApprovalResolver }
    | { kind: 'confirm'; resolve: ConfirmResolver }
    | { kind: 'question'; resolve: QuestionResolver };

export const useAskUserStore = defineStore('askUser', () => {
    const queue = ref<AskUserRequest[]>([]);
    const resolvers = new Map<string, ResolverEntry>();

    const current = computed<AskUserRequest | null>(() => queue.value[0] ?? null);
    const hasPending = computed(() => queue.value.length > 0);
    const pendingApprovalCallIds = computed<Set<string>>(() => {
        const set = new Set<string>();
        for (const item of queue.value) {
            if (item.kind === 'approval') {
                set.add(item.payload.callId);
            }
        }
        return set;
    });

    function popAndResolve(index: number, invoke: (entry: ResolverEntry) => void): boolean {
        const item = queue.value[index];
        if (!item) {
            return false;
        }
        const entry = resolvers.get(item.id);
        resolvers.delete(item.id);
        queue.value.splice(index, 1);
        if (entry) {
            invoke(entry);
        }
        return true;
    }

    function enqueueApproval(
        payload: ToolApprovalDecisionRequest,
        resolve: ApprovalResolver
    ): string {
        const existingIndex = queue.value.findIndex(
            (item) => item.kind === 'approval' && item.payload.callId === payload.callId
        );
        if (existingIndex >= 0) {
            const existing = queue.value[existingIndex];
            const existingResolver = existing ? resolvers.get(existing.id) : undefined;
            if (existing && existingResolver?.kind === 'approval') {
                const prev = existingResolver.resolve;
                resolvers.set(existing.id, {
                    kind: 'approval',
                    resolve: (approved) => {
                        prev(approved);
                        resolve(approved);
                    },
                });
                return existing.id;
            }
        }
        const id = crypto.randomUUID();
        queue.value.push({
            id,
            kind: 'approval',
            createdAt: Date.now(),
            payload,
        });
        resolvers.set(id, { kind: 'approval', resolve });
        return id;
    }

    function enqueueConfirm(options: AskUserConfirmOptions, resolve: ConfirmResolver): string {
        const id = crypto.randomUUID();
        queue.value.push({
            id,
            kind: 'confirm',
            createdAt: Date.now(),
            options,
        });
        resolvers.set(id, { kind: 'confirm', resolve });
        return id;
    }

    function enqueueQuestion(
        questions: AskUserQuestion[],
        resolve: QuestionResolver,
        opts: { sourceCallId?: string } = {}
    ): string {
        const id = crypto.randomUUID();
        queue.value.push({
            id,
            kind: 'question',
            createdAt: Date.now(),
            questions,
            sourceCallId: opts.sourceCallId,
        });
        resolvers.set(id, { kind: 'question', resolve });
        return id;
    }

    function approveCurrentApproval(): boolean {
        if (queue.value[0]?.kind !== 'approval') {
            return false;
        }
        return popAndResolve(0, (entry) => {
            if (entry.kind === 'approval') {
                entry.resolve(true);
            }
        });
    }

    function rejectCurrentApproval(): boolean {
        if (queue.value[0]?.kind !== 'approval') {
            return false;
        }
        return popAndResolve(0, (entry) => {
            if (entry.kind === 'approval') {
                entry.resolve(false);
            }
        });
    }

    function confirmCurrentConfirm(): boolean {
        if (queue.value[0]?.kind !== 'confirm') {
            return false;
        }
        return popAndResolve(0, (entry) => {
            if (entry.kind === 'confirm') {
                entry.resolve(true);
            }
        });
    }

    function cancelCurrentConfirm(): boolean {
        if (queue.value[0]?.kind !== 'confirm') {
            return false;
        }
        return popAndResolve(0, (entry) => {
            if (entry.kind === 'confirm') {
                entry.resolve(false);
            }
        });
    }

    function answerCurrentQuestion(answers: AskUserAnswer[]): boolean {
        if (queue.value[0]?.kind !== 'question') {
            return false;
        }
        return popAndResolve(0, (entry) => {
            if (entry.kind === 'question') {
                entry.resolve(answers);
            }
        });
    }

    function cancelCurrentQuestion(): boolean {
        if (queue.value[0]?.kind !== 'question') {
            return false;
        }
        return popAndResolve(0, (entry) => {
            if (entry.kind === 'question') {
                entry.resolve(null);
            }
        });
    }

    function cancelByApprovalCallId(callId: string, reason?: string): boolean {
        const index = queue.value.findIndex(
            (item) => item.kind === 'approval' && item.payload.callId === callId
        );
        if (index < 0) {
            return false;
        }
        return popAndResolve(index, (entry) => {
            if (entry.kind === 'approval') {
                entry.resolve(false, reason);
            }
        });
    }

    function resolveApprovalByCallId(callId: string, approved: boolean, reason?: string): boolean {
        const index = queue.value.findIndex(
            (item) => item.kind === 'approval' && item.payload.callId === callId
        );
        if (index < 0) {
            return false;
        }
        return popAndResolve(index, (entry) => {
            if (entry.kind === 'approval') {
                entry.resolve(approved, reason);
            }
        });
    }

    function cancelByQuestionCallId(callId: string): boolean {
        const index = queue.value.findIndex(
            (item) => item.kind === 'question' && item.sourceCallId === callId
        );
        if (index < 0) {
            return false;
        }
        return popAndResolve(index, (entry) => {
            if (entry.kind === 'question') {
                entry.resolve(null);
            }
        });
    }

    function clearAll(reason?: string): void {
        const entries = queue.value.map((item) => ({
            id: item.id,
            entry: resolvers.get(item.id) ?? null,
        }));
        queue.value = [];
        resolvers.clear();
        for (const { entry } of entries) {
            if (!entry) {
                continue;
            }
            if (entry.kind === 'approval') {
                entry.resolve(false, reason);
            } else if (entry.kind === 'confirm') {
                entry.resolve(false);
            } else {
                entry.resolve(null);
            }
        }
    }

    return {
        queue,
        current,
        hasPending,
        pendingApprovalCallIds,
        enqueueApproval,
        enqueueConfirm,
        enqueueQuestion,
        approveCurrentApproval,
        rejectCurrentApproval,
        confirmCurrentConfirm,
        cancelCurrentConfirm,
        answerCurrentQuestion,
        cancelCurrentQuestion,
        resolveApprovalByCallId,
        cancelByApprovalCallId,
        cancelByQuestionCallId,
        clearAll,
    };
});
