// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ToolApprovalDecisionRequest } from '@services/AiService/types';
import { computed, ref } from 'vue';

import type {
    ConversationMessage,
    PendingToolApproval,
    ToolApprovalInfo,
    ToolCallInfo,
} from '@/types/conversation';

interface UseToolApprovalOptions {
    getAssistantMessageById: (messageId: string) => ConversationMessage | undefined;
    ensureAssistantApprovals: (message: ConversationMessage) => ToolApprovalInfo[];
    ensureApprovalPart: (message: ConversationMessage, callId: string) => void;
    updateToolCallStatus: (
        messageId: string,
        callId: string,
        updater: (toolCall: ToolCallInfo) => void
    ) => void;
}

/**
 * 管理工具审批的前端状态机。
 *
 * 它只关心审批卡片、阻塞 promise 与键盘审批队列，不直接感知请求流或 AI provider。
 */
export function useToolApproval(options: UseToolApprovalOptions) {
    const {
        getAssistantMessageById,
        ensureAssistantApprovals,
        ensureApprovalPart,
        updateToolCallStatus,
    } = options;

    const pendingApprovalQueue = ref<PendingToolApproval[]>([]);
    const approvalResolvers = new Map<string, (approved: boolean) => void>();
    const pendingToolApproval = computed(() => pendingApprovalQueue.value[0] ?? null);

    const updateToolApproval = (
        messageId: string,
        callId: string,
        updater: (approval: ToolApprovalInfo) => void
    ): void => {
        const message = getAssistantMessageById(messageId);
        const approval = message?.approvals?.find((item) => item.callId === callId);

        if (approval) {
            updater(approval);
        }
    };

    const removeToolApproval = (messageId: string, callId: string): void => {
        const message = getAssistantMessageById(messageId);
        if (!message) {
            return;
        }

        if (message.approvals) {
            message.approvals = message.approvals.filter((item) => item.callId !== callId);
        }

        message.parts = message.parts.filter(
            (part) => !(part.type === 'approval' && part.callId === callId)
        );
    };

    const removePendingApproval = (callId: string): PendingToolApproval | null => {
        const target = pendingApprovalQueue.value.find((approval) => approval.callId === callId);
        if (!target) {
            return null;
        }

        pendingApprovalQueue.value = pendingApprovalQueue.value.filter(
            (approval) => approval.callId !== callId
        );
        return target;
    };

    /**
     * 把审批事件转成可见卡片，同时把 tool call 状态切到等待批准。
     *
     * 这样 request 回调和 tool event 都复用同一套 UI 更新路径，避免出现两套审批视图状态。
     */
    const presentToolApproval = (
        messageId: string,
        payload: ToolApprovalDecisionRequest
    ): ToolApprovalInfo | null => {
        const message = getAssistantMessageById(messageId);
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
        updateToolCallStatus(messageId, payload.callId, (toolCall) => {
            toolCall.status = 'awaiting_approval';
        });

        return approval;
    };

    /**
     * 把后端“等待用户批准”的阻塞点转换成前端可交互的 deferred。
     *
     * 如果同一次调用同时收到了 approval event 和 callback，会复用同一个 resolver，
     * 避免前端出现两个互相竞争的审批 promise。
     */
    const requestToolApproval = (
        messageId: string,
        payload: ToolApprovalDecisionRequest
    ): Promise<boolean> => {
        const approval = presentToolApproval(messageId, payload);
        if (!approval) {
            return Promise.resolve(false);
        }

        const existingResolver = approvalResolvers.get(payload.callId);
        if (existingResolver) {
            return new Promise<boolean>((resolve) => {
                approvalResolvers.set(payload.callId, (approved) => {
                    existingResolver(approved);
                    resolve(approved);
                });
            });
        }

        pendingApprovalQueue.value = [
            ...pendingApprovalQueue.value.filter((item) => item.callId !== payload.callId),
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
            },
        ];

        return new Promise<boolean>((resolve) => {
            approvalResolvers.set(payload.callId, resolve);
        });
    };

    const settlePendingApproval = (
        callId: string,
        approved: boolean,
        options: { resolutionText?: string } = {}
    ): boolean => {
        const target = removePendingApproval(callId);
        const resolver = approvalResolvers.get(callId);
        approvalResolvers.delete(callId);

        if (!target || !resolver) {
            return false;
        }

        const resolutionText =
            options.resolutionText ?? (approved ? '已批准执行此命令' : '已拒绝执行此命令');

        updateToolCallStatus(target.messageId, callId, (toolCall) => {
            if (approved) {
                toolCall.status = 'executing';
                return;
            }

            toolCall.status = 'rejected';
            toolCall.isError = true;
            toolCall.result = resolutionText;
        });

        if (approved) {
            removeToolApproval(target.messageId, callId);
        } else {
            updateToolApproval(target.messageId, callId, (approval) => {
                approval.status = 'rejected';
                approval.resolutionText = resolutionText;
            });
        }

        resolver(approved);
        return true;
    };

    const clearPendingApprovals = (reason = '请求已取消'): void => {
        const callIds = [...approvalResolvers.keys()];
        for (const callId of callIds) {
            settlePendingApproval(callId, false, { resolutionText: reason });
        }
        pendingApprovalQueue.value = [];
    };

    /**
     * 工具执行结束后，审批 promise 已经没有继续保留的价值。
     *
     * 这里不改 UI，只做内部队列与 resolver 清理，避免残留状态污染后续请求。
     */
    const cleanupApprovalState = (callId: string): void => {
        removePendingApproval(callId);
        approvalResolvers.delete(callId);
    };

    function approvePendingToolApproval(callId?: string): boolean {
        const targetCallId = callId ?? pendingToolApproval.value?.callId;
        if (!targetCallId) {
            return false;
        }

        return settlePendingApproval(targetCallId, true);
    }

    function rejectPendingToolApproval(callId?: string): boolean {
        const targetCallId = callId ?? pendingToolApproval.value?.callId;
        if (!targetCallId) {
            return false;
        }

        return settlePendingApproval(targetCallId, false);
    }

    return {
        pendingApprovalQueue,
        pendingToolApproval,
        presentToolApproval,
        requestToolApproval,
        settlePendingApproval,
        clearPendingApprovals,
        cleanupApprovalState,
        approvePendingToolApproval,
        rejectPendingToolApproval,
    };
}
