// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * 把 MCP 工具和内置工具的执行状态统一映射成中文文案。
 */
export function getToolLogStatusText(status: string): string {
    switch (status) {
        case 'success':
            return '成功';
        case 'error':
            return '错误';
        case 'timeout':
            return '超时';
        case 'awaiting_approval':
            return '待审批';
        case 'approved':
            return '已批准';
        case 'rejected':
            return '已拒绝';
        case 'pending':
            return '进行中';
        default:
            return status;
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
        case 'pending':
            return 'bg-gray-100 text-gray-700';
        default:
            return 'bg-gray-100 text-gray-700';
    }
}
