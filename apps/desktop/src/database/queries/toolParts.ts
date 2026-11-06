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
export type ToolCallPartData = { toolCallId: string } & (
    | (Omit<McpToolLogEntity, ToolPartIdentity> & { toolKind: 'mcp' })
    | (Omit<BuiltInToolLogEntity, ToolPartIdentity> & { toolKind: 'builtin' })
);

export type ToolPartEntity = McpToolLogEntity | BuiltInToolLogEntity;
export type { ToolPartFilter } from '@services/NativeService/database';

export function readToolCallData(part: MessagePartEntity): ToolCallPartData {
    return JSON.parse(part.data) as ToolCallPartData;
}

export function getToolCallName(data: ToolCallPartData): string {
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
        limit: options?.limit,
        offset: options?.offset,
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
    filter: ToolPartFilter,
    patch: McpToolLogUpdateData | BuiltInToolLogUpdateData
): Promise<ToolPartEntity | undefined> {
    return (
        (await native.database.operation<ToolPartEntity | null>({
            kind: 'tool_part_update',
            toolKind: kind,
            filter,
            data: { ...patch },
        })) ?? undefined
    );
}
