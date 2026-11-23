import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../contracts/builtin';
import type { ToolMessages } from '../../contracts/host';
import {
    DEFAULT_READ_CONVERSATION_TOOL_CONFIG,
    parseReadConversationToolConfig,
    type ReadConversationToolConfig,
} from './configuration';
import {
    READ_CONVERSATION_MAX_BYTES,
    READ_CONVERSATION_TOOL_DESCRIPTION,
    READ_CONVERSATION_TOOL_INPUT_SCHEMA,
} from './constants';
import {
    parseReadConversationArguments,
    type ReadConversationArguments,
    truncateText,
    utf8ByteLength,
} from './operations';

export interface ReadConversationSession {
    id: number;
    session_id: string;
    title: string;
    model: string;
    created_at: string;
    archived: boolean;
}

export interface ReadConversationMessage {
    id: number;
    role: 'user' | 'assistant';
    created_at: string;
    content: string;
}

export interface ReadConversationHistory {
    findSession(sessionId: string): Promise<ReadConversationSession | null>;
    listMessages(options: {
        sessionId: number;
        anchorId?: number;
        direction: 'before' | 'after';
        limit: number;
        roles: readonly ('user' | 'assistant')[];
    }): Promise<ReadConversationMessage[]>;
}

interface ReadConversationOutputMessage {
    message_id: number;
    role: 'user' | 'assistant';
    created_at: string;
    text: string;
    truncated: boolean;
}

interface ReadConversationOutput {
    session: {
        session_id: string;
        title: string;
        model: string;
        created_at: string;
        archived: boolean;
    };
    messages: ReadConversationOutputMessage[];
    next_cursor: { message_id: number; direction: 'before' | 'after' } | null;
    has_more: boolean;
}

function buildPage(
    messages: readonly ReadConversationMessage[],
    args: ReadConversationArguments
): { messages: ReadConversationOutputMessage[]; hasMore: boolean } {
    const output: ReadConversationOutputMessage[] = [];
    let bytes = 0;
    for (const message of messages) {
        const truncated = truncateText(message.content, args.max_chars_per_message);
        const entry: ReadConversationOutputMessage = {
            message_id: message.id,
            role: message.role,
            created_at: message.created_at,
            text: truncated.text,
            truncated: truncated.truncated,
        };
        const entryBytes = utf8ByteLength(JSON.stringify(entry));
        if (output.length > 0 && bytes + entryBytes > READ_CONVERSATION_MAX_BYTES) {
            return { messages: output, hasMore: true };
        }
        bytes += entryBytes;
        output.push(entry);
    }
    return { messages: output, hasMore: false };
}

function buildOutput(
    session: ReadConversationSession,
    page: { messages: ReadConversationOutputMessage[]; hasMore: boolean },
    args: ReadConversationArguments
): string {
    const last = page.messages[page.messages.length - 1];
    const first = page.messages[0];
    const cursorSource = args.direction === 'before' ? first : last;
    const output: ReadConversationOutput = {
        session: {
            session_id: session.session_id,
            title: session.title,
            model: session.model,
            created_at: session.created_at,
            archived: session.archived,
        },
        messages: page.messages,
        next_cursor:
            page.hasMore && cursorSource
                ? { message_id: cursorSource.message_id, direction: args.direction }
                : null,
        has_more: page.hasMore,
    };
    return JSON.stringify(output);
}

export function createReadConversationTools(input: {
    messages: ToolMessages;
    history: ReadConversationHistory;
}): BuiltInToolGroup {
    const { history } = input;

    class ReadConversationTool extends BuiltInTool<ReadConversationToolConfig> {
        readonly id = 'read_conversation' as const;
        readonly displayName = 'ReadConversation';
        readonly description = READ_CONVERSATION_TOOL_DESCRIPTION;
        readonly inputSchema = READ_CONVERSATION_TOOL_INPUT_SCHEMA;
        readonly defaultConfig = DEFAULT_READ_CONVERSATION_TOOL_CONFIG;

        override parseConfig(text: string | null) {
            return parseReadConversationToolConfig(text);
        }

        override buildConversationSemantic(args: Record<string, unknown>) {
            const session = typeof args.session_id === 'string' ? args.session_id.trim() : '';
            return {
                action: 'read',
                target:
                    session || input.messages.t('settings.builtInTools.summary.readConversation'),
            } satisfies BuiltInToolConversationSemantic;
        }

        override async execute(
            args: Record<string, unknown>,
            config: ReadConversationToolConfig,
            context: BaseBuiltInToolExecutionContext
        ): Promise<BuiltInToolExecutionResult> {
            const disabledMessage = input.messages.t('builtInTools.readConversation.disabled');
            if (!config.enabled) {
                return {
                    result: disabledMessage,
                    isError: true,
                    status: 'error',
                    errorMessage: disabledMessage,
                };
            }

            const parsed = parseReadConversationArguments(args);
            try {
                context.signal?.throwIfAborted();
                const session = await history.findSession(parsed.session_id);
                if (!session) {
                    const notFound = input.messages.t('builtInTools.readConversation.notFound', {
                        sessionId: parsed.session_id,
                    });
                    return {
                        result: notFound,
                        isError: true,
                        status: 'error',
                        errorMessage: notFound,
                    };
                }

                const rows = await history.listMessages({
                    sessionId: session.id,
                    anchorId: parsed.message_id,
                    direction: parsed.direction,
                    limit: parsed.limit + 1,
                    roles: parsed.roles,
                });
                context.signal?.throwIfAborted();

                const overflow =
                    rows.length > parsed.limit
                        ? parsed.direction === 'before'
                            ? rows.slice(1)
                            : rows.slice(0, parsed.limit)
                        : rows;
                const page = buildPage(overflow, parsed);
                const hasMore = rows.length > parsed.limit || page.hasMore;
                const result = buildOutput(session, { messages: page.messages, hasMore }, parsed);
                context.signal?.throwIfAborted();
                return { result, isError: false, status: 'success' };
            } catch (error) {
                if (context.signal?.aborted) throw error;
                const detail = error instanceof Error ? error.message : String(error);
                const message = input.messages.t('builtInTools.readConversation.error', {
                    message: detail,
                });
                return {
                    result: message,
                    isError: true,
                    status: 'error',
                    errorMessage: detail,
                };
            }
        }
    }

    return [new ReadConversationTool()];
}
