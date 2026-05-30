// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    AskUserAnswer,
    AskUserQuestion,
    ToolApprovalDecisionRequest,
} from '@/services/AgentService/contracts/tooling';
import { type AskUserConfirmOptions, useAskUserStore } from '@/stores/askUser';

export function useAskUser() {
    const store = useAskUserStore();

    function requestApproval(payload: ToolApprovalDecisionRequest): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            store.enqueueApproval(payload, resolve);
        });
    }

    function requestConfirm(options: AskUserConfirmOptions): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            store.enqueueConfirm(options, resolve);
        });
    }

    function requestQuestion(
        questions: AskUserQuestion[],
        opts: { sourceCallId?: string } = {}
    ): Promise<AskUserAnswer[] | null> {
        return new Promise<AskUserAnswer[] | null>((resolve) => {
            store.enqueueQuestion(questions, resolve, opts);
        });
    }

    return {
        requestApproval,
        requestConfirm,
        requestQuestion,
    };
}
