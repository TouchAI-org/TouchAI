// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 工具审批队列投影。
 *
 * 持有待决审批队列与 Promise resolver 映射，
 * 负责审批卡片在会话消息中的创建、更新与清理。
 */

import type { PendingToolApproval, SessionMessage, ToolApprovalInfo } from '@/types/session';

import type { ToolApprovalDecisionRequest } from '../../contracts/tooling';
import { isCancellationStatusText } from './helpers';

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

// ────────────────────── 审批结算结果 ──────────────────────

export interface ApprovalSettlementResult {
    target: PendingToolApproval;
    approved: boolean;
    resolutionText: string;
    isCancellationResolution: boolean;
}

// ────────────────────── ProjectionApprovals ──────────────────────

/**
 * 审批队列投影状态管理器。
 *
 * 维护待决审批队列和 resolver 映射，
 * 提供审批展示、结算和清理操作。
 */
export class ProjectionApprovals {
    private readonly queue: PendingToolApproval[] = [];
    private readonly resolvers = new Map<string, (approved: boolean) => void>();

    get pendingQueue(): readonly PendingToolApproval[] {
        return this.queue;
    }

    get hasPending(): boolean {
        return this.queue.length > 0;
    }

    getPending(): PendingToolApproval | null {
        return this.queue[0] ?? null;
    }

    /**
     * 在会话消息中创建审批卡片。
     */
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
            title: payload.title ?? '命令执行需要确认',
            description: payload.description ?? '这是一个高风险命令，请确认后再继续执行。',
            command: payload.command,
            riskLabel: payload.riskLabel ?? '高风险',
            reason: payload.reason ?? '命令可能修改文件或系统状态。',
            commandLabel: payload.commandLabel ?? '命令预览',
            approveLabel: payload.approveLabel ?? '批准执行',
            rejectLabel: payload.rejectLabel ?? '拒绝执行',
            enterHint: payload.enterHint ?? 'Enter 批准',
            escHint: payload.escHint ?? 'Esc 拒绝',
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

    /**
     * 注册审批请求并返回等待用户决策的 Promise。
     */
    requestApproval(
        history: SessionMessage[],
        messageId: string,
        payload: ToolApprovalDecisionRequest
    ): Promise<boolean> | null {
        const approval = this.presentApproval(history, messageId, payload);
        if (!approval) {
            return null;
        }

        const existingResolver = this.resolvers.get(payload.callId);
        if (existingResolver) {
            return new Promise<boolean>((resolve) => {
                this.resolvers.set(payload.callId, (approved) => {
                    existingResolver(approved);
                    resolve(approved);
                });
            });
        }

        this.queue.splice(
            0,
            this.queue.length,
            ...this.queue.filter((item) => item.callId !== payload.callId),
            {
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
            }
        );

        return new Promise<boolean>((resolve) => {
            this.resolvers.set(payload.callId, resolve);
        });
    }

    /**
     * 结算指定审批。
     *
     * 从队列中移除审批条目、获取 resolver 并触发 Promise 结算，
     * 返回结算结果供主投影器同步工具调用状态和审批卡片 UI。
     */
    settle(
        callId: string,
        approved: boolean,
        options: { resolutionText?: string } = {}
    ): ApprovalSettlementResult | null {
        const target = this.dequeue(callId);
        const resolver = this.resolvers.get(callId);
        this.resolvers.delete(callId);

        if (!target || !resolver) {
            return null;
        }

        const resolutionText =
            options.resolutionText ?? (approved ? '已批准执行此命令' : '已拒绝执行此命令');
        const isCancellationResolution = !approved && isCancellationStatusText(resolutionText);

        resolver(approved);

        return {
            target,
            approved,
            resolutionText,
            isCancellationResolution,
        };
    }

    /**
     * 清空所有待决审批，返回每个审批的结算结果。
     */
    clearAll(reason = '请求已取消'): ApprovalSettlementResult[] {
        const callIds = [...this.resolvers.keys()];
        const results: ApprovalSettlementResult[] = [];
        for (const callId of callIds) {
            const result = this.settle(callId, false, { resolutionText: reason });
            if (result) {
                results.push(result);
            }
        }
        this.queue.length = 0;
        return results;
    }

    /**
     * 仅清理指定 callId 的队列条目和 resolver，不触发结算。
     */
    cleanup(callId: string): void {
        this.dequeue(callId);
        this.resolvers.delete(callId);
    }

    private dequeue(callId: string): PendingToolApproval | null {
        const target = this.queue.find((approval) => approval.callId === callId);
        if (!target) {
            return null;
        }

        const nextQueue = this.queue.filter((approval) => approval.callId !== callId);
        this.queue.splice(0, this.queue.length, ...nextQueue);
        return target;
    }
}
