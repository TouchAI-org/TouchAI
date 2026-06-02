// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    buildDesktopContextToolPayload,
} from '@/services/DesktopContextService/toolPayload';
import type {
    DesktopContextInclude,
    DesktopContextToolRequest,
} from '@/services/DesktopContextService/types';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    DESKTOP_CONTEXT_INCLUDE_VALUES,
    DESKTOP_CONTEXT_TOOL_DESCRIPTION,
    DESKTOP_CONTEXT_TOOL_INPUT_SCHEMA,
    DESKTOP_CONTEXT_TOOL_NAME,
} from './constants';

const includeValues = new Set<string>(DESKTOP_CONTEXT_INCLUDE_VALUES);

function parseDesktopContextRequest(args: Record<string, unknown>): DesktopContextToolRequest {
    const include = Array.isArray(args.include)
        ? args.include.filter((item): item is DesktopContextInclude => {
              return typeof item === 'string' && includeValues.has(item);
          })
        : undefined;

    return {
        ...(include ? { include } : {}),
        ...(typeof args.scope === 'string'
            ? { scope: args.scope as DesktopContextToolRequest['scope'] }
            : {}),
        ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        ...(typeof args.screenshotTarget === 'string'
            ? {
                  screenshotTarget:
                      args.screenshotTarget as DesktopContextToolRequest['screenshotTarget'],
              }
            : {}),
    };
}

class DesktopContextTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'get_desktop_context' as const;
    readonly displayName = DESKTOP_CONTEXT_TOOL_NAME;
    readonly description = DESKTOP_CONTEXT_TOOL_DESCRIPTION;
    readonly inputSchema = DESKTOP_CONTEXT_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(): BuiltInToolConversationSemantic {
        return {
            action: 'review',
            target: '桌面上下文',
        };
    }

    override async execute(
        args: Record<string, unknown>,
        _config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        const request = parseDesktopContextRequest(args);
        const payload = buildDesktopContextToolPayload(context.desktopContext, request);

        return {
            result: JSON.stringify(payload, null, 2),
            isError: !payload.available,
            status: payload.available ? 'success' : 'error',
            errorMessage: payload.available ? undefined : payload.reason,
        };
    }
}

export const desktopContextTool = new DesktopContextTool();
export const builtInTools: BuiltInToolGroup = [desktopContextTool];
