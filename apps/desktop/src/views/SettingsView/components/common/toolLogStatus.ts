// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { t, type MessageKey } from '@/i18n';

const statusTextKeyByStatus: Record<string, MessageKey> = {
    success: 'toolLog.status.success',
    error: 'toolLog.status.error',
    timeout: 'toolLog.status.timeout',
    awaiting_approval: 'toolLog.status.awaitingApproval',
    approved: 'toolLog.status.approved',
    rejected: 'toolLog.status.rejected',
    cancelled: 'toolLog.status.cancelled',
    pending: 'toolLog.status.pending',
};

const approvalStateTextKeyByStatus: Record<string, MessageKey> = {
    pending: 'builtInTools.logs.approvalState.pending',
    approved: 'builtInTools.logs.approvalState.approved',
    rejected: 'builtInTools.logs.approvalState.rejected',
};

/**
 * 把 MCP 工具和内置工具的执行状态统一映射成当前界面语言的文案。
 */
export function getToolLogStatusText(status: string): string {
    const key = statusTextKeyByStatus[status];
    return key ? t(key) : status;
}

export function getBuiltInToolApprovalStateText(status: string | null | undefined): string | null {
    switch (status) {
        case null:
        case undefined:
        case '':
        case 'none':
            return null;
        default:
            return approvalStateTextKeyByStatus[status]
                ? t(approvalStateTextKeyByStatus[status])
                : status;
    }
}

/**
 * 统一日志视图里的状态徽标样式，同时保留审批等内置工具专属状态。
 */
export function getToolLogStatusClass(status: string): string {
    switch (status) {
        case 'success':
            return 'bg-green-100 text-green-700';
        case 'error':
            return 'bg-red-100 text-red-700';
        case 'timeout':
            return 'bg-orange-100 text-orange-700';
        case 'awaiting_approval':
            return 'bg-amber-100 text-amber-700';
        case 'approved':
            return 'bg-sky-100 text-sky-700';
        case 'rejected':
            return 'bg-gray-100 text-gray-700';
        case 'cancelled':
            return 'bg-gray-100 text-gray-700';
        case 'pending':
            return 'bg-gray-100 text-gray-700';
        default:
            return 'bg-gray-100 text-gray-700';
    }
}
