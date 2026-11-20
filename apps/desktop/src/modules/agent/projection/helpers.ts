// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 投影器共享工具函数。
 *
 * 这里只放不依赖任何投影器内部状态的纯函数，
 * 供 `widgets`、`approvals`、`toolCalls` 和主投影器统一复用。
 */

import { normalizeString } from '@/utils/text';

import type { SessionMessage } from '../contracts/history';
import type { ToolEvent } from '../contracts/presentation';
import type { TaskModelSummary } from '../contracts/task';
import { cloneTaskValue, type TaskViewSnapshot } from '../contracts/task';
import { createTextPart } from '../history/parts';

export type MutableTaskStatus = TaskViewSnapshot['status'];

export function cloneValue<T>(value: T): T {
    return cloneTaskValue(value);
}

export function createTaskModelFromToolEvent(
    summary: Extract<ToolEvent, { type: 'model_switched' }>['toModel'],
    previous: TaskModelSummary | null
): TaskModelSummary {
    return {
        modelDbId: previous?.modelDbId ?? null,
        providerId: summary.providerId,
        providerName: summary.providerName,
        modelId: summary.modelId,
        modelName: summary.modelName,
    };
}

export function createDerivedStatusMessage(
    content: string,
    flags: Pick<SessionMessage, 'isCancelled' | 'isError' | 'isRetrying'> = {}
): SessionMessage {
    return {
        id: crypto.randomUUID(),
        role: 'assistant',
        content,
        parts: [createTextPart(content)],
        timestamp: Date.now(),
        ...flags,
    };
}

export function attachStatusText(message: SessionMessage, statusText: string): void {
    message.statusText = statusText;
}

export function isCancellationStatusText(text?: string | null): boolean {
    const normalized = normalizeString(text)?.toLowerCase() ?? '';
    if (!normalized) {
        return false;
    }

    return (
        normalized.includes('取消') ||
        normalized.includes('cancelled by user') ||
        normalized.includes('request cancelled')
    );
}

export function isTerminalStatus(status: MutableTaskStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}
