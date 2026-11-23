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
    READ_CONVERSATION_MAX_TITLE_CODE_POINTS,
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
    hasMessage(sessionId: number, messageId: number): Promise<boolean>;
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
    session: ReadConversationSession,
    messages: readonly ReadConversationMessage[],
    args: ReadConversationArguments,
    moreAvailable: boolean
): string {
    const ordered = args.direction === 'before' ? [...messages].reverse() : [...messages];
    let output: ReadConversationOutputMessage[] = [];
    let hasMore = moreAvailable;

    for (let index = 0; index < ordered.length; index += 1) {
        const message = ordered[index]!;
        const truncated = truncateText(message.content, args.max_chars_per_message);
        const entry: ReadConversationOutputMessage = {
            message_id: message.id,
            role: message.role,
            created_at: message.created_at,
            text: truncated.text,
            truncated: truncated.truncated,
        };
        const candidate = args.direction === 'before' ? [entry, ...output] : [...output, entry];
        const remaining = index < ordered.length - 1;
        if (!fits(session, candidate, args, hasMore || remaining)) {
            hasMore = true;
            break;
        }
        output = candidate;
    }

    if (output.length === 0 && ordered.length > 0) {
        output = [fitFirstMessage(session, ordered[0]!, args)];
        hasMore = moreAvailable || ordered.length > 1;
    }

    return serialize(session, output, args, hasMore);
}

function truncateTitle(title: string): string {
    const points = Array.from(title);
    if (points.length <= READ_CONVERSATION_MAX_TITLE_CODE_POINTS) return title;
    return `${points.slice(0, READ_CONVERSATION_MAX_TITLE_CODE_POINTS).join('')}…`;
}

function serialize(
    session: ReadConversationSession,
    messages: readonly ReadConversationOutputMessage[],
    args: ReadConversationArguments,
    hasMore: boolean
): string {
    const cursorSource = args.direction === 'before' ? messages[0] : messages[messages.length - 1];
    const output: ReadConversationOutput = {
        session: {
            session_id: session.session_id,
            title: truncateTitle(session.title),
            model: session.model,
            created_at: session.created_at,
            archived: session.archived,
        },
        messages: [...messages],
        next_cursor:
            hasMore && cursorSource
                ? { message_id: cursorSource.message_id, direction: args.direction }
                : null,
        has_more: hasMore,
    };
    return JSON.stringify(output);
}

function fits(
    session: ReadConversationSession,
    messages: readonly ReadConversationOutputMessage[],
    args: ReadConversationArguments,
    hasMore: boolean
): boolean {
    return (
        utf8ByteLength(serialize(session, messages, args, hasMore)) <= READ_CONVERSATION_MAX_BYTES
    );
}

function fitFirstMessage(
    session: ReadConversationSession,
    message: ReadConversationMessage,
    args: ReadConversationArguments
): ReadConversationOutputMessage {
    const entry = (text: string): ReadConversationOutputMessage => ({
        message_id: message.id,
        role: message.role,
        created_at: message.created_at,
        text,
        truncated: true,
    });
    const points = Array.from(message.content);
    let low = 0;
    let high = Math.min(points.length, args.max_chars_per_message);
    let best = entry('');
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = entry(points.slice(0, middle).join(''));
        if (fits(session, [candidate], args, true)) {
            best = candidate;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return best;
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

                if (
                    parsed.message_id !== undefined &&
                    !(await history.hasMessage(session.id, parsed.message_id))
                ) {
                    const invalidAnchor = input.messages.t(
                        'builtInTools.readConversation.invalidAnchor',
                        { messageId: parsed.message_id }
                    );
                    return {
                        result: invalidAnchor,
                        isError: true,
                        status: 'error',
                        errorMessage: invalidAnchor,
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

                const moreAvailable = rows.length > parsed.limit;
                const pageRows = moreAvailable
                    ? parsed.direction === 'before'
                        ? rows.slice(1)
                        : rows.slice(0, parsed.limit)
                    : rows;
                const result = buildPage(session, pageRows, parsed, moreAvailable);
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
