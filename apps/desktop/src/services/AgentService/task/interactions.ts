// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 任务交互所有权。
 *
 * 审批与结构化提问的「等待」和「结算」由任务层持有，而不是由投影层持有：
 * - 投影只负责把交互事实渲染成卡片与快照字段；
 * - 能否等待与投影里有没有可见的 assistant 消息无关；
 * - 每个等待项按生命周期 generation + attempt token 归属，重试/终态/取消一定会释放并结算。
 *
 * 身份规则（fail closed）：
 * - 登记必须带当前 attempt token，旧 attempt 的迟到回调会被立即拒绝；
 * - 结算必须带不落库的 `decisionId`，缺失、过期、旧 generation 一律拒绝；
 * - 任务终态后登记立即结算，不会新挂起；
 * - 重复登记共享同一个 Promise，不会无界堆积 resolver。
 */

import type { PendingToolApproval } from '@/types/session';

import type { AskUserAnswer, AskUserQuestion } from '../contracts/tooling';

export interface PendingUserQuestion {
    callId: string;
    sourceMessageId: string;
    questions: AskUserQuestion[];
    createdAt: number;
    decisionId?: string;
}

export interface ApprovalSettlement {
    display: PendingToolApproval;
    approved: boolean;
}

export interface InteractionRelease {
    approvals: ApprovalSettlement[];
    questionCallIds: string[];
}

interface ApprovalEntry {
    attemptId: number;
    attemptToken: string;
    decisionId: string;
    display: PendingToolApproval;
    promise: Promise<boolean>;
    resolve: (approved: boolean) => void;
}

interface QuestionEntry {
    attemptId: number;
    attemptToken: string;
    decisionId: string;
    record: PendingUserQuestion;
    promise: Promise<AskUserAnswer[] | null>;
    resolve: (answers: AskUserAnswer[] | null) => void;
}

const EMPTY_RELEASE: InteractionRelease = { approvals: [], questionCallIds: [] };

/**
 * 单任务内的待决交互集合。
 *
 * 保持插入顺序（Map 迭代顺序），因此「队列第一个」就是最早登记的等待项。
 */
export class TaskInteractions {
    /**
     * 生命周期 generation。
     *
     * 与重试计数无关：只在每个 `attempt_started` 推进一代，因此运行时上报的
     * retry 计数（第一次重试为 1）不会和交互归属混用。
     */
    private generation = 0;
    private currentAttemptToken = '';
    /**
     * 当前 attempt 是否仍在接受登记。
     *
     * 默认关闭：只有运行时明确发出 `attempt_started` 并 stamp 当前 token 后，
     * 才存在可归属的交互 scope。无 token 的旧回调或首次 attempt 之前的事件
     * 一律 fail closed。
     * `endAttempt` 关闭它，`beginAttempt` 重新打开，从而在重试延迟窗口内
     * 拒绝上一次 attempt 的迟到登记。
     */
    private open = false;
    private closed = false;
    private decisionCounter = 0;
    private readonly approvals = new Map<string, ApprovalEntry>();
    private readonly questions = new Map<string, QuestionEntry>();

    constructor(private readonly taskId: string = '') {}

    getTaskId(): string {
        return this.taskId;
    }

    /** 当前生命周期 generation，用作等待项的归属标识。 */
    get attemptId(): number {
        return this.generation;
    }

    get attemptToken(): string {
        return this.currentAttemptToken;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /**
     * 当前 attempt 是否接受带该 token 的登记。
     *
     * 供调用方在格式化/渲染卡片之前判断，避免为一次注定被拒绝的迟到请求
     * 渲染出幽灵卡片。
     */
    acceptsRegistration(attemptToken?: string): boolean {
        if (this.closed || !this.open) {
            return false;
        }
        return (
            typeof attemptToken === 'string' &&
            attemptToken.length > 0 &&
            attemptToken === this.currentAttemptToken
        );
    }

    get hasPending(): boolean {
        return this.approvals.size > 0 || this.questions.size > 0;
    }

    get pendingApproval(): PendingToolApproval | null {
        const first = this.approvals.values().next();
        return first.done ? null : first.value.display;
    }

    get pendingApprovals(): PendingToolApproval[] {
        return [...this.approvals.values()].map((entry) => entry.display);
    }

    get pendingQuestion(): PendingUserQuestion | null {
        const first = this.questions.values().next();
        return first.done ? null : first.value.record;
    }

    /**
     * 进入下一生命周期 generation。
     *
     * 关联的 attempt token 必须由调用方提供（来自运行时的 attempt 身份）。
     * 空 token 不会打开登记入口。
     */
    beginAttempt(attemptToken: string): InteractionRelease {
        const release = this.releaseAll(() => true);
        this.generation += 1;
        this.currentAttemptToken = attemptToken;
        this.open = attemptToken.length > 0;
        return release;
    }

    /**
     * 结束当前 attempt 的登记窗口。
     *
     * 释放它的全部等待项并关闭登记入口（但**不**永久关闭整个任务）：重试延迟
     * 或终态处理期间，上一次 attempt 的迟到回调会被立即拒绝，直到下一次
     * `beginAttempt` 打开新的 attempt。
     */
    endAttempt(): InteractionRelease {
        const release = this.releaseAll(() => true);
        this.open = false;
        this.currentAttemptToken = '';
        return release;
    }

    /**
     * 登记一个审批等待。必须在通知观察者之前调用。
     *
     * - 已终态时立即 resolve(false)，不新挂起；
     * - 同一 generation 的重复 callId 共享同一个 Promise（不堆积 resolver）；
     * - 迟到的旧 attempt token 立即 resolve(false)，不会登记成新请求。
     */
    registerApproval(display: PendingToolApproval, attemptToken?: string): Promise<boolean> {
        if (!this.acceptsRegistration(attemptToken)) {
            return Promise.resolve(false);
        }

        const existing = this.approvals.get(display.callId);
        if (existing && existing.attemptId === this.generation) {
            display.decisionId = existing.decisionId;
            return existing.promise;
        }
        if (existing) {
            this.approvals.delete(existing.display.callId);
            existing.resolve(false);
        }

        const decisionId = this.nextDecisionId(display.callId);
        display.decisionId = decisionId;
        let resolve!: (approved: boolean) => void;
        const promise = new Promise<boolean>((resolveFn) => {
            resolve = resolveFn;
        });
        this.approvals.set(display.callId, {
            attemptId: this.generation,
            attemptToken: this.currentAttemptToken,
            decisionId,
            display,
            promise,
            resolve,
        });
        return promise;
    }

    registerQuestion(
        record: PendingUserQuestion,
        attemptToken?: string
    ): Promise<AskUserAnswer[] | null> {
        if (!this.acceptsRegistration(attemptToken)) {
            return Promise.resolve(null);
        }

        const existing = this.questions.get(record.callId);
        if (existing && existing.attemptId === this.generation) {
            record.decisionId = existing.decisionId;
            return existing.promise;
        }
        if (existing) {
            this.questions.delete(existing.record.callId);
            existing.resolve(null);
        }

        const decisionId = this.nextDecisionId(record.callId);
        record.decisionId = decisionId;
        let resolve!: (answers: AskUserAnswer[] | null) => void;
        const promise = new Promise<AskUserAnswer[] | null>((resolveFn) => {
            resolve = resolveFn;
        });
        this.questions.set(record.callId, {
            attemptId: this.generation,
            attemptToken: this.currentAttemptToken,
            decisionId,
            record,
            promise,
            resolve,
        });
        return promise;
    }

    /**
     * 结算一个审批。
     *
     * 只有「当前 generation 登记、且决定携带的 decisionId 与登记一致」的 callId
     * 才会被接受：未知、已结算、旧 generation、缺失或旧 token 一律返回 null。
     */
    settleApproval(
        callId: string,
        approved: boolean,
        decisionId: string | undefined
    ): ApprovalSettlement | null {
        const entry = this.approvals.get(callId);
        if (!entry || entry.attemptId !== this.generation) {
            return null;
        }
        if (!decisionId || decisionId !== entry.decisionId) {
            return null;
        }

        this.approvals.delete(callId);
        entry.resolve(approved);
        return { display: entry.display, approved };
    }

    settleQuestion(
        callId: string,
        answers: AskUserAnswer[] | null,
        decisionId: string | undefined
    ): boolean {
        const entry = this.questions.get(callId);
        if (!entry || entry.attemptId !== this.generation) {
            return false;
        }
        if (!decisionId || decisionId !== entry.decisionId) {
            return false;
        }

        this.questions.delete(callId);
        entry.resolve(answers);
        return true;
    }

    /** 取消整个任务：释放所有等待项并进入终态，之后登记会立即结算。 */
    cancelAll(): InteractionRelease {
        const release = this.releaseAll(() => true);
        this.open = false;
        this.closed = true;
        return release;
    }

    private nextDecisionId(callId: string): string {
        this.decisionCounter += 1;
        return `${this.taskId || 'task'}:${this.generation}:${callId}:${this.decisionCounter}`;
    }

    private releaseAll(matches: (entry: { attemptId: number }) => boolean): InteractionRelease {
        const approvals: ApprovalSettlement[] = [];
        for (const entry of [...this.approvals.values()]) {
            if (!matches(entry)) {
                continue;
            }
            this.approvals.delete(entry.display.callId);
            entry.resolve(false);
            approvals.push({ display: entry.display, approved: false });
        }

        const questionCallIds: string[] = [];
        for (const entry of [...this.questions.values()]) {
            if (!matches(entry)) {
                continue;
            }
            this.questions.delete(entry.record.callId);
            entry.resolve(null);
            questionCallIds.push(entry.record.callId);
        }

        if (approvals.length === 0 && questionCallIds.length === 0) {
            return EMPTY_RELEASE;
        }

        return { approvals, questionCallIds };
    }
}
