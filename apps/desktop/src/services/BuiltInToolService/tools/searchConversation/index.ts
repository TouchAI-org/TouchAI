// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    SEARCH_CONVERSATION_TOOL_DESCRIPTION,
    SEARCH_CONVERSATION_TOOL_INPUT_SCHEMA,
} from './constants';
import {
    executeSearchConversationTool,
    parseSearchConversationRequest,
    sanitizeSearchConversationLogInput,
} from './helper';

function buildSearchConversationSemantic(
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    try {
        const request = parseSearchConversationRequest(sanitizeSearchConversationLogInput(args));
        return {
            action: 'search',
            target: request.query || request.keywords.join(', ') || '历史会话',
        };
    } catch {
        return { action: 'search', target: '历史会话' };
    }
}

class SearchConversationTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'search_conversation' as const;
    readonly displayName = 'SearchConversation';
    readonly description = SEARCH_CONVERSATION_TOOL_DESCRIPTION;
    readonly inputSchema = SEARCH_CONVERSATION_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildSearchConversationSemantic(args);
    }

    override sanitizeLogInput(args: Record<string, unknown>): Record<string, unknown> {
        return sanitizeSearchConversationLogInput(args);
    }

    override execute(args: Record<string, unknown>): Promise<BuiltInToolExecutionResult> {
        return executeSearchConversationTool(args);
    }
}

export const searchConversationTool = new SearchConversationTool();
export const builtInTools: BuiltInToolGroup = [searchConversationTool];
