import type { PendingToolApproval } from '../contracts/history';
import type { PendingUserQuestionView } from '../contracts/task';

export interface InteractionRelease {
    approvals: { display: PendingToolApproval; approved: boolean }[];
    questionCallIds: string[];
}

/** Mirrors Core-issued identities for display. It creates no decision, wait, or resolver. */
export class ProjectionDecisions {
    private readonly approvals = new Map<string, PendingToolApproval>();
    private readonly questions = new Map<string, PendingUserQuestionView>();

    get pendingApproval(): PendingToolApproval | null {
        return this.approvals.values().next().value ?? null;
    }
    get pendingApprovals(): PendingToolApproval[] {
        return [...this.approvals.values()];
    }
    get pendingQuestion(): PendingUserQuestionView | null {
        return this.questions.values().next().value ?? null;
    }
    get hasPending(): boolean {
        return this.approvals.size > 0 || this.questions.size > 0;
    }

    recordApproval(display: PendingToolApproval): void {
        if (display.decisionId) this.approvals.set(display.decisionId, display);
    }

    recordQuestion(record: PendingUserQuestionView): void {
        if (record.decisionId) this.questions.set(record.decisionId, record);
    }

    resolve(decisionId: string, approved: boolean): InteractionRelease {
        const display = this.approvals.get(decisionId);
        const question = this.questions.get(decisionId);
        this.approvals.delete(decisionId);
        this.questions.delete(decisionId);
        return {
            approvals: display ? [{ display, approved }] : [],
            questionCallIds: question ? [question.callId] : [],
        };
    }

    clear(): InteractionRelease {
        const release = {
            approvals: [...this.approvals.values()].map((display) => ({
                display,
                approved: false,
            })),
            questionCallIds: [...this.questions.values()].map((question) => question.callId),
        };
        this.approvals.clear();
        this.questions.clear();
        return release;
    }
}
