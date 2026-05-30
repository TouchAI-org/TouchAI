// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import { parseToolArguments } from '../../utils/toolSchema';
import {
    APPLY_PATCH_TOOL_DESCRIPTION,
    APPLY_PATCH_TOOL_INPUT_SCHEMA,
    APPLY_PATCH_TOOL_NAME,
    applyPatchArgsSchema,
} from './constants';
import { formatApplyPatchToolResult } from './helper';

type ApplyPatchArgs = ReturnType<typeof parseApplyPatchArgs>;

function parseApplyPatchArgs(args: Record<string, unknown>) {
    return parseToolArguments(APPLY_PATCH_TOOL_NAME, applyPatchArgsSchema, args);
}

function normalizePatchPath(path: string): string {
    return path.trim().replace(/\\/g, '/');
}

function collectPatchTargets(patch: string): string[] {
    const targets: string[] = [];
    const lines = patch.replace(/\r\n/g, '\n').split('\n');

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined) {
            continue;
        }

        const addTarget = line.match(/^\*\*\* Add File: (.+)$/)?.[1];
        if (addTarget?.trim()) {
            targets.push(`新增 ${normalizePatchPath(addTarget)}`);
            continue;
        }

        const updateTarget = line.match(/^\*\*\* Update File: (.+)$/)?.[1];
        if (updateTarget?.trim()) {
            const sourcePath = normalizePatchPath(updateTarget);
            const moveTarget = lines[index + 1]?.match(/^\*\*\* Move to: (.+)$/)?.[1];
            if (moveTarget?.trim()) {
                targets.push(`移动 ${sourcePath} → ${normalizePatchPath(moveTarget)}`);
                index += 1;
            } else {
                targets.push(`修改 ${sourcePath}`);
            }
            continue;
        }

        const deleteTarget = line.match(/^\*\*\* Delete File: (.+)$/)?.[1];
        if (deleteTarget?.trim()) {
            targets.push(`删除 ${normalizePatchPath(deleteTarget)}`);
        }
    }

    return [...new Set(targets)];
}

function buildApplyPatchSummary(args: ApplyPatchArgs): string {
    const targets = collectPatchTargets(args.patch);
    if (targets.length === 0) {
        return '文件';
    }

    return truncateText(targets.join(', '), 160);
}

function buildApplyPatchConversationSemantic(
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    try {
        const parsedArgs = parseApplyPatchArgs(args);
        return {
            action: 'update',
            target: buildApplyPatchSummary(parsedArgs),
        };
    } catch {
        return {
            action: 'update',
            target: '文件',
        };
    }
}

export function createApplyPatchApprovalRequest(
    args: Record<string, unknown>
): ToolApprovalRequest | null {
    let parsedArgs: ApplyPatchArgs;
    try {
        parsedArgs = parseApplyPatchArgs(args);
    } catch {
        return null;
    }

    const requestedReason =
        normalizeOptionalString(parsedArgs.reason, { collapseWhitespace: true }) ??
        normalizeOptionalString(parsedArgs.description, { collapseWhitespace: true }) ??
        '';

    return {
        title: '文件修改确认',
        description: requestedReason,
        command: [
            `工作目录: ${parsedArgs.workingDirectory}`,
            `变更目标: ${buildApplyPatchSummary(parsedArgs)}`,
        ].join('\n'),
        riskLabel: '',
        reason: '此操作会通过结构化补丁修改本地工作区文件。',
        commandLabel: '',
        approveLabel: '批准',
        rejectLabel: '拒绝',
        enterHint: 'Enter',
        escHint: 'Esc',
        keyboardApproveDelayMs: 450,
    };
}

export async function executeApplyPatchTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void config;
    void context.signal;

    const parsedArgs = parseApplyPatchArgs(args);
    try {
        const response = await native.builtInTools.applyPatch({
            patch: parsedArgs.patch,
            workingDirectory: parsedArgs.workingDirectory,
        });

        return {
            result: response.summary,
            displayResult: formatApplyPatchToolResult(response),
            isError: false,
            status: 'success',
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            result: `补丁应用失败：${errorMessage}`,
            isError: true,
            status: 'error',
            errorMessage,
        };
    }
}

class ApplyPatchTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'apply_patch' as const;
    readonly displayName = 'ApplyPatch';
    readonly description = APPLY_PATCH_TOOL_DESCRIPTION;
    readonly inputSchema = APPLY_PATCH_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildApprovalRequest(args: Record<string, unknown>) {
        return createApplyPatchApprovalRequest(args);
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildApplyPatchConversationSemantic(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeApplyPatchTool(args, config, context);
    }
}

export const applyPatchTool = new ApplyPatchTool();
export const builtInTools: BuiltInToolGroup = [applyPatchTool];

export { parseApplyPatchToolResult } from './helper';
