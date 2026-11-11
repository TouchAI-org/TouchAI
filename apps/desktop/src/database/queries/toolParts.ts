// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';
import type { ToolPartFilter } from '@services/NativeService/database';

import type { ToolLogKind } from '../schema';
import type {
    BuiltInToolLogEntity,
    BuiltInToolLogUpdateData,
    McpToolLogEntity,
    McpToolLogUpdateData,
    MessagePartEntity,
} from '../types';

type ToolPartIdentity = 'id' | 'tool_call_id' | 'session_id' | 'message_id' | 'created_at';
/** The JSON payload stored by tool_call parts, not a flattened message or log reference. */
export type ToolCallPartData = {
    toolCallId: string;
    /** Rejected names with no canonical tool identity must survive replay unchanged. */
    requestedName?: string;
} & (
    | (Omit<McpToolLogEntity, ToolPartIdentity> & { toolKind: 'mcp' })
    | (Omit<BuiltInToolLogEntity, ToolPartIdentity> & { toolKind: 'builtin' })
);

export type ToolPartEntity = McpToolLogEntity | BuiltInToolLogEntity;
export type { ToolPartFilter } from '@services/NativeService/database';

export function readToolCallData(part: MessagePartEntity): ToolCallPartData {
    return JSON.parse(part.data) as ToolCallPartData;
}

export function getToolCallName(data: ToolCallPartData): string {
    if (typeof data.requestedName === 'string') return data.requestedName;
    return data.toolKind === 'builtin'
        ? `builtin__${data.tool_id}`
        : `mcp__${data.server_id}__${data.tool_name}`;
}

export async function findToolParts(
    kind: ToolLogKind,
    filter: ToolPartFilter,
    options?: { limit?: number; offset?: number }
): Promise<ToolPartEntity[]> {
    return native.database.operation<ToolPartEntity[]>({
        kind: 'tool_part_list',
        toolKind: kind,
        filter,
        limit: options ? (options.limit ?? 100) : undefined,
        offset: options ? (options.offset ?? 0) : undefined,
    });
}

/**
 * 日志列表的轻量投影。
 *
 * 列表只需要展示字段与输入摘要，不再把完整 input/output JSON 拉进内存；
 * 完整正文由 `findToolPartById` 在用户展开时按需读取。
 */
export interface ToolPartSummaryRow {
    id: number;
    tool_call_id: string | null;
    tool_name: string;
    session_id: number | null;
    message_id: number;
    created_at: string;
    status: string;
    duration_ms: number | null;
    server_id: number | null;
    input_preview: string | null;
    output_length: number;
}

/** 按日志主键读取完整工具调用记录。 */
export async function findToolPartById(
    kind: ToolLogKind,
    id: number
): Promise<ToolPartEntity | undefined> {
    const rows = await native.database.operation<ToolPartEntity[]>({
        kind: 'tool_part_list',
        toolKind: kind,
        filter: { kind: 'id', id },
        limit: 1,
        offset: 0,
    });
    return rows[0];
}

/** 按工具类型收集列表摘要，避免读取完整 input/output。 */
export async function findToolPartSummaries(
    kind: ToolLogKind,
    filter: ToolPartFilter,
    options?: { limit?: number; offset?: number }
): Promise<ToolPartSummaryRow[]> {
    return native.database.operation<ToolPartSummaryRow[]>({
        kind: 'tool_part_summaries',
        toolKind: kind,
        filter,
        limit: options ? (options.limit ?? 100) : undefined,
        offset: options ? (options.offset ?? 0) : undefined,
    });
}

export async function createToolPart(
    kind: ToolLogKind,
    data: Record<string, unknown>
): Promise<ToolPartEntity> {
    return enqueueToolPartWrite(async () => {
        const created = await native.database.operation<ToolPartEntity | null>({
            kind: 'tool_part_create',
            toolKind: kind,
            data,
        });
        if (!created) {
            throw new Error('Failed to persist tool part');
        }
        return created;
    });
}

/** 全局写入队列：保证单进程内的工具片段写入顺序可预期。 */
let toolPartWriteChain: Promise<unknown> = Promise.resolve();

/** 仅供测试：把操作排进与 `createToolPart` 同一个队列。 */
export function enqueueToolPartWrite<T>(operation: () => Promise<T>): Promise<T> {
    const scheduled = toolPartWriteChain.then(operation, operation);
    toolPartWriteChain = scheduled.then(
        () => undefined,
        () => undefined
    );
    return scheduled;
}

export async function updateToolPart(
    kind: ToolLogKind,
    target: number | ToolPartFilter,
    patch: McpToolLogUpdateData | BuiltInToolLogUpdateData
): Promise<ToolPartEntity | undefined> {
    const filter: ToolPartFilter = typeof target === 'number' ? { kind: 'id', id: target } : target;
    return (
        (await native.database.operation<ToolPartEntity | null>({
            kind: 'tool_part_update',
            toolKind: kind,
            filter,
            data: { ...patch },
        })) ?? undefined
    );
}
