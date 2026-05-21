// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import { READ_TOOL_DESCRIPTION, READ_TOOL_INPUT_SCHEMA } from './constants';
import { buildReadApprovalRequest, buildReadConversationSemantic, executeReadFile } from './helper';

export async function executeReadTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void config;

    try {
        const output = await executeReadFile(args, context);
        return {
            result: output.result,
            attachments: output.attachments,
            isError: false,
            status: 'success',
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            result: errorMessage,
            isError: true,
            status: 'error',
            errorMessage,
        };
    }
}

class ReadTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'read' as const;
    readonly displayName = 'Read';
    readonly description = READ_TOOL_DESCRIPTION;
    readonly inputSchema = READ_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildApprovalRequest(args: Record<string, unknown>) {
        return buildReadApprovalRequest(args);
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildReadConversationSemantic(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeReadTool(args, config, context);
    }
}

export const readTool = new ReadTool();
export const builtInTools: BuiltInToolGroup = [readTool];
