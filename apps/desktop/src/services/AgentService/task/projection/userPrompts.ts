// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 用户提示队列投影。
 *
 * 维护待决审批和待决结构化提问的队列与 Promise resolver 映射，
 * 负责审批卡片在会话消息中的创建、更新与清理。
 */

import type { PendingToolApproval, SessionMessage, ToolApprovalInfo } from '@/types/session';

import type {
    AskUserAnswer,
    AskUserQuestion,
    ToolApprovalDecisionRequest,
} from '../../contracts/tooling';
import { isCancellationStatusText } from './helpers';

const APP_OWNED_APPROVAL_SOURCE_TEXT_BY_TRANSLATION = new Map<string, string>([
    ['Confirmation required', '需要确认'],
    ['Confirm command execution', '命令执行确认'],
    ['Confirm local content read', '读取本地内容确认'],
    ['Confirm model switch', '模型切换确认'],
    ['Confirm setting change', '设置修改确认'],
    ['Command execution needs confirmation', '命令执行需要确认'],
    [
        'This is a high-risk command. Confirm before continuing.',
        '这是一个高风险命令，请确认后再继续执行。',
    ],
    ['High risk', '高风险'],
    ['The command may modify files or system state.', '命令可能修改文件或系统状态。'],
    ['Command preview', '命令预览'],
    ['Approve execution', '批准执行'],
    ['Reject execution', '拒绝执行'],
    ['Enter to approve', 'Enter 批准'],
    ['Esc to reject', 'Esc 拒绝'],
    ['Approve', '批准'],
    ['Reject', '拒绝'],
    ['Approved this command', '已批准执行此命令'],
    ['Rejected this command', '已拒绝执行此命令'],
    ['The user rejected this command', '用户已拒绝执行此命令'],
    ['Request cancelled', '请求已取消'],
    [
        'Current configuration requires approval before every Bash command.',
        '当前配置要求所有 Bash 命令都必须先批准。',
    ],
    ['The command may delete files or directories.', '命令可能删除文件或目录。'],
    ['The command may reset or clean the Git worktree.', '命令可能重置或清理 Git 工作区。'],
    ['The command may modify or overwrite file contents.', '命令可能修改或覆盖文件内容。'],
    [
        'The command contains output redirection and may overwrite files.',
        '命令包含输出重定向，可能覆写文件。',
    ],
    [
        'The command may modify system configuration or affect device state.',
        '命令可能修改系统配置或影响设备状态。',
    ],
    [
        'This operation reads local file or directory contents and sends the result to the model.',
        '此操作会读取本地文件或目录内容，并将结果发送给模型。',
    ],
    [
        'This changes the model used by the current conversation and also affects the subsequent default model.',
        '这会修改当前问答后续使用的模型，并同步影响后续默认模型。',
    ],
    [
        'This operation changes TouchAI application settings and affects future behavior immediately.',
        '此操作会修改 TouchAI 的应用设置，并立即影响后续行为。',
    ],
]);

function canonicalizeAppOwnedApprovalText(value?: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return value;
    }

    const translatedSource = APP_OWNED_APPROVAL_SOURCE_TEXT_BY_TRANSLATION.get(trimmed);
    if (translatedSource) {
        return translatedSource;
    }

    const modelSwitchMatch = /^Allow switching from (.+) to (.+)$/.exec(trimmed);
    if (modelSwitchMatch) {
        return `允许从 ${modelSwitchMatch[1]} 切换到 ${modelSwitchMatch[2]}`;
    }

    return value;
}

// ────────────────────── 消息结构工具函数 ──────────────────────

function ensureAssistantApprovals(message: SessionMessage): ToolApprovalInfo[] {
    if (!message.approvals) {
        message.approvals = [];
    }
    return message.approvals;
}

function ensureApprovalPart(message: SessionMessage, callId: string): void {
    const hasPart = message.parts.some(
        (part) => part.type === 'approval' && part.callId === callId
    );
    if (!hasPart) {
        message.parts.push({
            id: crypto.randomUUID(),
            type: 'approval',
            callId,
        });
    }
}

export function updateToolApproval(
    history: SessionMessage[],
    messageId: string,
    callId: string,
    updater: (approval: ToolApprovalInfo) => void
): void {
    const message = history.find((item) => item.id === messageId && item.role === 'assistant');
    const approval = message?.approvals?.find((item) => item.callId === callId);
    if (approval) {
        updater(approval);
    }
}

export function removeToolApproval(
    history: SessionMessage[],
    messageId: string,
    callId: string
): void {
    const message = history.find((item) => item.id === messageId && item.role === 'assistant');
    if (!message) {
        return;
    }
    if (message.approvals) {
        message.approvals = message.approvals.filter((item) => item.callId !== callId);
    }
    message.parts = message.parts.filter(
        (part) => !(part.type === 'approval' && part.callId === callId)
    );
}

export interface ApprovalSettlementResult {
    target: PendingToolApproval;
    approved: boolean;
    resolutionText: string;
    isCancellationResolution: boolean;
}

export interface PendingUserQuestion {
    callId: string;
    sourceMessageId: string;
    questions: AskUserQuestion[];
    createdAt: number;
}

/**
 * 用户提示队列投影。
 *
 * 同时管理审批队列与结构化提问队列。
 */
export class ProjectionUserPrompts {
    private readonly approvalQueue: PendingToolApproval[] = [];
    private readonly approvalResolvers = new Map<string, (approved: boolean) => void>();
    private readonly questionQueue: PendingUserQuestion[] = [];
    private readonly questionResolvers = new Map<
        string,
        (answers: AskUserAnswer[] | null) => void
    >();

    get pendingApprovalQueue(): readonly PendingToolApproval[] {
        return this.approvalQueue;
    }

    get pendingQuestionQueue(): readonly PendingUserQuestion[] {
        return this.questionQueue;
    }

    get hasPending(): boolean {
        return this.approvalQueue.length > 0 || this.questionQueue.length > 0;
    }

    getPendingApproval(): PendingToolApproval | null {
        return this.approvalQueue[0] ?? null;
    }

    getPendingQuestion(): PendingUserQuestion | null {
        return this.questionQueue[0] ?? null;
    }

    presentApproval(
        history: SessionMessage[],
        messageId: string,
        payload: ToolApprovalDecisionRequest
    ): ToolApprovalInfo | null {
        const message = history.find((item) => item.id === messageId && item.role === 'assistant');
        if (!message) {
            return null;
        }

        const keyboardApproveAt = Date.now() + (payload.keyboardApproveDelayMs ?? 450);
        const approval: ToolApprovalInfo = {
            id: crypto.randomUUID(),
            callId: payload.callId,
            status: 'pending',
            title: canonicalizeAppOwnedApprovalText(payload.title) ?? '命令执行需要确认',
            description:
                canonicalizeAppOwnedApprovalText(payload.description) ??
                '这是一个高风险命令，请确认后再继续执行。',
            command: payload.command,
            riskLabel: canonicalizeAppOwnedApprovalText(payload.riskLabel) ?? '高风险',
            reason:
                canonicalizeAppOwnedApprovalText(payload.reason) ?? '命令可能修改文件或系统状态。',
            commandLabel: canonicalizeAppOwnedApprovalText(payload.commandLabel) ?? '命令预览',
            approveLabel: canonicalizeAppOwnedApprovalText(payload.approveLabel) ?? '批准执行',
            rejectLabel: canonicalizeAppOwnedApprovalText(payload.rejectLabel) ?? '拒绝执行',
            enterHint: canonicalizeAppOwnedApprovalText(payload.enterHint) ?? 'Enter 批准',
            escHint: canonicalizeAppOwnedApprovalText(payload.escHint) ?? 'Esc 拒绝',
            keyboardApproveAt,
        };

        const approvals = ensureAssistantApprovals(message);
        const existingApproval = approvals.find((item) => item.callId === payload.callId);
        if (existingApproval) {
            Object.assign(existingApproval, approval);
        } else {
            approvals.push(approval);
        }

        ensureApprovalPart(message, payload.callId);
        return approval;
    }

    requestApproval(
        history: SessionMessage[],
        messageId: string,
        payload: ToolApprovalDecisionRequest
    ): Promise<boolean> | null {
        const approval = this.presentApproval(history, messageId, payload);
        if (!approval) {
            return null;
        }

        const existingResolver = this.approvalResolvers.get(payload.callId);
        if (existingResolver) {
            return new Promise<boolean>((resolve) => {
                this.approvalResolvers.set(payload.callId, (approved) => {
                    existingResolver(approved);
                    resolve(approved);
                });
            });
        }

        const filtered = this.approvalQueue.filter((item) => item.callId !== payload.callId);
        this.approvalQueue.splice(0, this.approvalQueue.length, ...filtered, {
            callId: payload.callId,
            messageId,
            title: approval.title,
            description: approval.description,
            command: approval.command,
            riskLabel: approval.riskLabel,
            reason: approval.reason,
            approveLabel: approval.approveLabel,
            rejectLabel: approval.rejectLabel,
            enterHint: approval.enterHint,
            escHint: approval.escHint,
            keyboardApproveAt: approval.keyboardApproveAt,
        });

        return new Promise<boolean>((resolve) => {
            this.approvalResolvers.set(payload.callId, resolve);
        });
    }

    requestQuestion(
        callId: string,
        sourceMessageId: string,
        questions: AskUserQuestion[]
    ): Promise<AskUserAnswer[] | null> | null {
        if (this.questionResolvers.has(callId)) {
            return null;
        }

        this.questionQueue.push({
            callId,
            sourceMessageId,
            questions,
            createdAt: Date.now(),
        });

        return new Promise<AskUserAnswer[] | null>((resolve) => {
            this.questionResolvers.set(callId, resolve);
        });
    }

    settleApproval(
        callId: string,
        approved: boolean,
        options: { resolutionText?: string } = {}
    ): ApprovalSettlementResult | null {
        const target = this.dequeueApproval(callId);
        const resolver = this.approvalResolvers.get(callId);
        this.approvalResolvers.delete(callId);

        if (!target || !resolver) {
            return null;
        }

        const resolutionText =
            canonicalizeAppOwnedApprovalText(options.resolutionText) ??
            (approved ? '已批准执行此命令' : '已拒绝执行此命令');
        const isCancellationResolution = !approved && isCancellationStatusText(resolutionText);

        resolver(approved);

        return {
            target,
            approved,
            resolutionText,
            isCancellationResolution,
        };
    }

    settleQuestion(callId: string, answers: AskUserAnswer[] | null): boolean {
        const resolver = this.questionResolvers.get(callId);
        if (!resolver) {
            return false;
        }

        this.questionResolvers.delete(callId);
        const index = this.questionQueue.findIndex((item) => item.callId === callId);
        if (index >= 0) {
            this.questionQueue.splice(index, 1);
        }

        resolver(answers);
        return true;
    }

    clearAll(reason = '请求已取消'): {
        approvals: ApprovalSettlementResult[];
        cancelledQuestionCallIds: string[];
    } {
        const approvalCallIds = [...this.approvalResolvers.keys()];
        const approvalResults: ApprovalSettlementResult[] = [];
        for (const callId of approvalCallIds) {
            const result = this.settleApproval(callId, false, { resolutionText: reason });
            if (result) {
                approvalResults.push(result);
            }
        }
        this.approvalQueue.length = 0;

        const questionCallIds = [...this.questionResolvers.keys()];
        for (const callId of questionCallIds) {
            this.settleQuestion(callId, null);
        }

        return { approvals: approvalResults, cancelledQuestionCallIds: questionCallIds };
    }

    cleanup(callId: string): void {
        this.dequeueApproval(callId);
        this.approvalResolvers.delete(callId);
        const index = this.questionQueue.findIndex((item) => item.callId === callId);
        if (index >= 0) {
            this.questionQueue.splice(index, 1);
        }
        this.questionResolvers.delete(callId);
    }

    private dequeueApproval(callId: string): PendingToolApproval | null {
        const target = this.approvalQueue.find((approval) => approval.callId === callId);
        if (!target) {
            return null;
        }

        const nextQueue = this.approvalQueue.filter((approval) => approval.callId !== callId);
        this.approvalQueue.splice(0, this.approvalQueue.length, ...nextQueue);
        return target;
    }
}
