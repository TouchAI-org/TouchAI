// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@/platform/native';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../../contracts/builtin';
import type { ToolMessages } from '../../../contracts/host';
import { FILE_SEARCH_TOOL_DESCRIPTION, FILE_SEARCH_TOOL_INPUT_SCHEMA } from './constants';
import { createFileSearchOperations } from './operations';

export function createFileSearchTools(input: { messages: ToolMessages }): BuiltInToolGroup {
    const tt = input.messages.tt.bind(input.messages);
    const { buildEverythingQuery, formatFileSearchResult } = createFileSearchOperations(
        input.messages
    );
    function buildFileSearchConversationSemantic(
        args: Record<string, unknown>
    ): BuiltInToolConversationSemantic {
        const query = normalizeOptionalString(args.query, { collapseWhitespace: true });
        return {
            action: 'search',
            target: query && query !== '*' ? truncateText(query, 80) : tt('本机文件'),
        };
    }

    /**
     * 执行 Everything 文件搜索，并把结果整理成稳定文本格式。
     * @param args 工具参数。
     * @param config 当前工具配置。
     * @param context 当前执行上下文。
     * @returns 标准化后的工具执行结果。
     */
    async function executeFileSearchTool(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        const queryContext = buildEverythingQuery(args);
        void config;

        try {
            context.signal?.throwIfAborted();
            const items = await native.quickSearch.searchFiles(
                queryContext.everythingQuery,
                queryContext.limit,
                {
                    includeShortcuts: queryContext.includeShortcutFiles,
                }
            );

            context.signal?.throwIfAborted();

            return {
                result: formatFileSearchResult(
                    queryContext.query,
                    queryContext.everythingQuery,
                    queryContext.limit,
                    items
                ),
                isError: false,
                status: 'success',
            };
        } catch (error) {
            const fallbackMessage = error instanceof Error ? error.message : String(error);
            const status = await native.quickSearch.getStatus().catch(() => null);
            const errorMessage = status?.last_error?.trim() || fallbackMessage;

            return {
                result: [
                    tt('本机文件搜索失败'),
                    `${tt('原始查询')}: ${queryContext.query}`,
                    `${tt('Everything 查询')}: ${queryContext.everythingQuery}`,
                    `${tt('原因')}: ${errorMessage}`,
                ].join('\n'),
                isError: true,
                status: 'error',
                errorMessage,
            };
        }
    }

    /**
     * FileSearch 工具。
     */
    class FileSearchTool extends BuiltInTool<Record<string, never>> {
        readonly id = 'file_search' as const;
        readonly displayName = 'FileSearch';
        readonly description = FILE_SEARCH_TOOL_DESCRIPTION;
        readonly inputSchema = FILE_SEARCH_TOOL_INPUT_SCHEMA;
        readonly defaultConfig = {};

        override buildConversationSemantic(args: Record<string, unknown>) {
            return buildFileSearchConversationSemantic(args);
        }

        override execute(
            args: Record<string, unknown>,
            config: Record<string, never>,
            context: BaseBuiltInToolExecutionContext
        ) {
            return executeFileSearchTool(args, config, context);
        }
    }

    return [new FileSearchTool()];
}
