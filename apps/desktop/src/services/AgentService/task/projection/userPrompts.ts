// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 用户提示卡片投影。
 *
 * 只负责把审批/提问渲染成会话消息里的展示卡片，并维护卡片状态的更新与清理。
 * 「等待」与「结算」所有权在任务层（`TaskInteractions`），本模块不持有 resolver。
 */

import type { PendingToolApproval, SessionMessage, ToolApprovalInfo } from '@/types/session';

import type { ToolApprovalDecisionRequest } from '../../contracts/tooling';

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

/**
 * 审批结算文本：优先采用调用方给出的本地化文本，否则回退到默认文案。
 */
export function resolveApprovalResolutionText(approved: boolean, resolutionText?: string): string {
    return (
        canonicalizeAppOwnedApprovalText(resolutionText) ??
        (approved ? '已批准执行此命令' : '已拒绝执行此命令')
    );
}

/**
 * 把审批请求格式化为可在会话历史中展示的卡片数据。
 */
function buildApprovalDisplay(
    messageId: string,
    payload: ToolApprovalDecisionRequest
): PendingToolApproval {
    return {
        callId: payload.callId,
        messageId,
        title: canonicalizeAppOwnedApprovalText(payload.title) ?? '命令执行需要确认',
        description:
            canonicalizeAppOwnedApprovalText(payload.description) ??
            '这是一个高风险命令，请确认后再继续执行。',
        command: payload.command,
        riskLabel: canonicalizeAppOwnedApprovalText(payload.riskLabel) ?? '高风险',
        reason: canonicalizeAppOwnedApprovalText(payload.reason) ?? '命令可能修改文件或系统状态。',
        approveLabel: canonicalizeAppOwnedApprovalText(payload.approveLabel) ?? '批准执行',
        rejectLabel: canonicalizeAppOwnedApprovalText(payload.rejectLabel) ?? '拒绝执行',
        enterHint: canonicalizeAppOwnedApprovalText(payload.enterHint) ?? 'Enter 批准',
        escHint: canonicalizeAppOwnedApprovalText(payload.escHint) ?? 'Esc 拒绝',
        keyboardApproveAt: Date.now() + (payload.keyboardApproveDelayMs ?? 450),
    };
}

/**
 * 用户提示卡片投影。
 *
 * 无状态：渲染卡片、返回展示数据。是否等待由任务层决定。
 */
export class ProjectionUserPrompts {
    /** 纯格式化：生成审批展示数据，不写入任何卡片。 */
    formatApproval(
        messageId: string | null,
        payload: ToolApprovalDecisionRequest
    ): PendingToolApproval {
        return buildApprovalDisplay(messageId ?? '', payload);
    }

    /** 把审批卡片写入消息；没有对应 assistant 消息时不写入并返回 null。 */
    renderApprovalCard(
        history: SessionMessage[],
        messageId: string | null,
        display: PendingToolApproval,
        payload: ToolApprovalDecisionRequest
    ): ToolApprovalInfo | null {
        const message = history.find((item) => item.id === messageId && item.role === 'assistant');
        if (!message) {
            return null;
        }

        const approval: ToolApprovalInfo = {
            id: crypto.randomUUID(),
            callId: display.callId,
            status: 'pending',
            title: display.title,
            description: display.description,
            command: display.command,
            riskLabel: display.riskLabel,
            reason: display.reason,
            commandLabel: canonicalizeAppOwnedApprovalText(payload.commandLabel) ?? '命令预览',
            approveLabel: display.approveLabel,
            rejectLabel: display.rejectLabel,
            enterHint: display.enterHint,
            escHint: display.escHint,
            keyboardApproveAt: display.keyboardApproveAt,
        };

        const approvals = ensureAssistantApprovals(message);
        const existingApproval = approvals.find((item) => item.callId === display.callId);
        if (existingApproval) {
            Object.assign(existingApproval, approval);
        } else {
            approvals.push(approval);
        }

        ensureApprovalPart(message, display.callId);
        return approval;
    }

    /**
     * 生成审批展示数据，并在存在对应 assistant 消息时写入审批卡片。
     *
     * 即使没有可见消息也返回展示数据：等待由任务层保证，卡片只是呈现。
     */
    presentApproval(
        history: SessionMessage[],
        messageId: string | null,
        payload: ToolApprovalDecisionRequest
    ): ToolApprovalInfo | null {
        return this.renderApprovalCard(
            history,
            messageId,
            this.formatApproval(messageId, payload),
            payload
        );
    }
}
