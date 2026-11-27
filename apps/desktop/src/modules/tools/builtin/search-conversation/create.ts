import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../contracts/builtin';
import type { ToolMessages, ToolModelCapabilities } from '../../contracts/host';
import {
    DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG,
    parseSearchConversationToolConfig,
    type SearchConversationToolConfig,
} from './configuration';
import {
    CONVERSATION_SEARCH_CANDIDATE_LIMIT,
    CONVERSATION_SEARCH_MAX_RANKING_OUTPUT_TOKENS,
    CONVERSATION_SEARCH_MAX_SNIPPETS,
    CONVERSATION_SEARCH_RANKING_DEADLINE_MS,
    SEARCH_CONVERSATION_TOOL_DESCRIPTION,
    SEARCH_CONVERSATION_TOOL_INPUT_SCHEMA,
} from './constants';
import {
    buildRankingPrompt,
    extractMatchedSnippet,
    parseRankingResponse,
    parseSearchConversationArguments,
    type RankingCandidate,
    type RankingMessage,
} from './operations';

export interface SearchConversationCandidate {
    id: number;
    session_id: string;
    title: string;
    model: string;
    created_at: string;
    last_message_at: string | null;
    message_count: number;
    archived_at: string | null;
}

export interface SearchConversationHistory {
    listCandidates(options: {
        query: string;
        limit: number;
        fromDate?: string;
        toDate?: string;
        model?: string;
        roles: readonly ('user' | 'assistant')[];
        textContentOnly: true;
    }): Promise<SearchConversationCandidate[]>;
    findMessages(
        sessionIds: readonly number[],
        roles: readonly ('user' | 'assistant')[]
    ): Promise<Array<RankingMessage & { session_id: number }>>;
    findMatchMessages(
        sessionIds: readonly number[],
        roles: readonly ('user' | 'assistant')[],
        query: string,
        limitPerSession: number
    ): Promise<Array<RankingMessage & { session_id: number }>>;
}

interface SearchConversationResultEntry {
    session_id: string;
    title: string;
    model: string;
    created_at: string;
    last_message_at: string | null;
    message_count: number;
    archived: boolean;
    matches: SearchConversationMatch[];
}

export interface SearchConversationMatch {
    message_id: number;
    role: 'user' | 'assistant';
    snippet: string;
}

interface SearchConversationOutput {
    ranking_status: 'model' | 'keyword';
    results: SearchConversationResultEntry[];
}

interface PreparedSearch {
    taskId: string;
}

type CompletionResult = { timedOut: true } | { timedOut: false; content: string };

function isSearchRole(value: string): value is 'user' | 'assistant' {
    return value === 'user' || value === 'assistant';
}

function buildSnippets(
    messages: readonly RankingMessage[],
    query: string
): SearchConversationMatch[] {
    const normalizedQuery = query.toLocaleLowerCase();
    const matches: SearchConversationMatch[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
        if (!message.content.toLocaleLowerCase().includes(normalizedQuery)) continue;
        const snippet = extractMatchedSnippet(message.content, query);
        if (!snippet || seen.has(snippet)) continue;
        seen.add(snippet);
        matches.push({ message_id: message.id, role: message.role, snippet });
        if (matches.length === CONVERSATION_SEARCH_MAX_SNIPPETS) break;
    }
    return matches;
}

function buildOutput(
    status: SearchConversationOutput['ranking_status'],
    candidates: readonly RankingCandidate[],
    selected: readonly number[]
): string {
    const output: SearchConversationOutput = {
        ranking_status: status,
        results: selected.map((index) => {
            const candidate = candidates[index]!;
            return {
                session_id: candidate.session_id,
                title: candidate.title,
                model: candidate.model,
                created_at: candidate.created_at,
                last_message_at: candidate.last_message_at,
                message_count: candidate.message_count,
                archived: false,
                matches: [],
            };
        }),
    };
    return JSON.stringify(output);
}

function buildOutputWithSnippets(
    status: SearchConversationOutput['ranking_status'],
    candidates: readonly RankingCandidate[],
    archivedBySessionId: ReadonlyMap<string, boolean>,
    snippetsByIndex: readonly SearchConversationMatch[][],
    selected: readonly number[]
): string {
    const output: SearchConversationOutput = {
        ranking_status: status,
        results: selected.map((index) => {
            const candidate = candidates[index]!;
            return {
                session_id: candidate.session_id,
                title: candidate.title,
                model: candidate.model,
                created_at: candidate.created_at,
                last_message_at: candidate.last_message_at,
                message_count: candidate.message_count,
                archived: archivedBySessionId.get(candidate.session_id) ?? false,
                matches: snippetsByIndex[index] ?? [],
            };
        }),
    };
    return JSON.stringify(output);
}

function completeWithDeadline(input: {
    taskId: string;
    models: ToolModelCapabilities;
    context: BaseBuiltInToolExecutionContext;
    systemPrompt: string;
    userContent: string;
}): Promise<CompletionResult> {
    const currentModel = input.context.currentModel;
    if (!currentModel) return Promise.resolve({ timedOut: true });

    return new Promise((resolve, reject) => {
        const controller = new AbortController();
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            input.context.signal?.removeEventListener('abort', abortFromContext);
        };
        const settle = (callback: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            callback();
        };
        const abortFromContext = () =>
            settle(() => {
                controller.abort(input.context.signal?.reason);
                reject(
                    input.context.signal?.reason ??
                        new DOMException('Conversation search cancelled', 'AbortError')
                );
            });
        const timer = setTimeout(
            () =>
                settle(() => {
                    controller.abort(new DOMException('Ranking deadline', 'TimeoutError'));
                    resolve({ timedOut: true });
                }),
            CONVERSATION_SEARCH_RANKING_DEADLINE_MS
        );

        if (input.context.signal?.aborted) {
            abortFromContext();
            return;
        }
        input.context.signal?.addEventListener('abort', abortFromContext, { once: true });
        input.models
            .complete(input.taskId, currentModel, {
                systemPrompt: input.systemPrompt,
                userContent: input.userContent,
                maxOutputTokens: CONVERSATION_SEARCH_MAX_RANKING_OUTPUT_TOKENS,
                signal: controller.signal,
            })
            .then(
                ({ content }) =>
                    settle(() =>
                        resolve({
                            timedOut: false,
                            content,
                        })
                    ),
                (error: unknown) =>
                    settle(() => {
                        reject(error);
                    })
            );
    });
}

export function createSearchConversationTools(input: {
    messages: ToolMessages;
    models: ToolModelCapabilities;
    history: SearchConversationHistory;
}): BuiltInToolGroup {
    const { history } = input;

    class SearchConversationTool extends BuiltInTool<SearchConversationToolConfig> {
        readonly id = 'search_conversation' as const;
        readonly displayName = 'SearchConversation';
        readonly description = SEARCH_CONVERSATION_TOOL_DESCRIPTION;
        readonly inputSchema = SEARCH_CONVERSATION_TOOL_INPUT_SCHEMA;
        readonly defaultConfig = DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG;

        constructor(private readonly prepared?: PreparedSearch) {
            super();
        }

        override parseConfig(text: string | null) {
            return parseSearchConversationToolConfig(text);
        }

        override async prepareForTurn(
            _config: SearchConversationToolConfig,
            scope?: {
                taskId: string;
                currentModel: NonNullable<BaseBuiltInToolExecutionContext['currentModel']>;
            }
        ) {
            if (!scope) throw new Error('TOOL_PREPARATION_REQUIRED');
            return new SearchConversationTool({ taskId: scope.taskId });
        }

        override buildConversationSemantic(args: Record<string, unknown>) {
            const query =
                typeof args.query === 'string'
                    ? Array.from(args.query.trim()).slice(0, 80).join('')
                    : '';
            return {
                action: 'search',
                target:
                    query || input.messages.t('settings.builtInTools.summary.searchConversation'),
            } satisfies BuiltInToolConversationSemantic;
        }

        override async execute(
            args: Record<string, unknown>,
            config: SearchConversationToolConfig,
            context: BaseBuiltInToolExecutionContext
        ): Promise<BuiltInToolExecutionResult> {
            const disabledMessage = input.messages.t('builtInTools.searchConversation.disabled');
            if (!config.enabled) {
                return {
                    result: disabledMessage,
                    isError: true,
                    status: 'error',
                    errorMessage: disabledMessage,
                };
            }

            const parsed = parseSearchConversationArguments(args);
            try {
                context.signal?.throwIfAborted();
                const sessions = (
                    await history.listCandidates({
                        query: parsed.query,
                        limit: CONVERSATION_SEARCH_CANDIDATE_LIMIT,
                        fromDate: parsed.from_date,
                        toDate: parsed.to_date,
                        model: parsed.model,
                        roles: parsed.roles,
                        textContentOnly: true,
                    })
                ).slice(0, CONVERSATION_SEARCH_CANDIDATE_LIMIT);
                context.signal?.throwIfAborted();

                if (sessions.length === 0) {
                    return {
                        result: buildOutput('keyword', [], []),
                        isError: false,
                        status: 'success',
                    };
                }

                const messages = (
                    await history.findMessages(
                        sessions.map((session) => session.id),
                        parsed.roles
                    )
                ).filter(
                    (message) => isSearchRole(message.role) && parsed.roles.includes(message.role)
                );
                context.signal?.throwIfAborted();

                const sessionIds = new Set(sessions.map((session) => session.id));
                const messagesBySession = new Map<number, RankingMessage[]>();
                for (const message of messages) {
                    if (!sessionIds.has(message.session_id) || !isSearchRole(message.role)) {
                        continue;
                    }
                    const current = messagesBySession.get(message.session_id);
                    if (current) current.push(message);
                    else messagesBySession.set(message.session_id, [message]);
                }

                const matchMessages = (
                    await history.findMatchMessages(
                        sessions.map((session) => session.id),
                        parsed.roles,
                        parsed.query,
                        CONVERSATION_SEARCH_MAX_SNIPPETS
                    )
                ).filter(
                    (message) => isSearchRole(message.role) && parsed.roles.includes(message.role)
                );
                context.signal?.throwIfAborted();

                const matchMessagesBySession = new Map<number, RankingMessage[]>();
                for (const message of matchMessages) {
                    if (!sessionIds.has(message.session_id) || !isSearchRole(message.role)) {
                        continue;
                    }
                    const current = matchMessagesBySession.get(message.session_id);
                    if (current) current.push(message);
                    else matchMessagesBySession.set(message.session_id, [message]);
                }

                const candidates: RankingCandidate[] = sessions.map((session) => ({
                    session_id: session.session_id,
                    title: session.title,
                    model: session.model,
                    created_at: session.created_at,
                    last_message_at: session.last_message_at,
                    message_count: session.message_count,
                    messages: messagesBySession.get(session.id) ?? [],
                }));
                const archivedBySessionId = new Map(
                    sessions.map((session) => [session.session_id, !!session.archived_at])
                );
                const snippets = sessions.map((session) =>
                    buildSnippets(matchMessagesBySession.get(session.id) ?? [], parsed.query)
                );
                const fallbackIndices = Array.from(
                    { length: Math.min(parsed.limit, candidates.length) },
                    (_, index) => index
                );

                const taskId = this.prepared?.taskId;
                if (!parsed.rerank || !taskId || !context.currentModel) {
                    return {
                        result: buildOutputWithSnippets(
                            'keyword',
                            candidates,
                            archivedBySessionId,
                            snippets,
                            fallbackIndices
                        ),
                        isError: false,
                        status: 'success',
                    };
                }

                const prompt = buildRankingPrompt(parsed.query, candidates);
                let completion: CompletionResult;
                try {
                    completion = await completeWithDeadline({
                        taskId,
                        models: input.models,
                        context,
                        ...prompt,
                    });
                } catch (error) {
                    if (context.signal?.aborted) throw error;
                    completion = { timedOut: true };
                }
                if (context.signal?.aborted) context.signal.throwIfAborted();

                const rankedIndices = completion.timedOut
                    ? null
                    : parseRankingResponse(completion.content, candidates.length, parsed.limit);
                return {
                    result: buildOutputWithSnippets(
                        rankedIndices ? 'model' : 'keyword',
                        candidates,
                        archivedBySessionId,
                        snippets,
                        rankedIndices ?? fallbackIndices
                    ),
                    isError: false,
                    status: 'success',
                };
            } catch (error) {
                if (context.signal?.aborted) throw error;
                const detail = error instanceof Error ? error.message : String(error);
                const message = input.messages.t('builtInTools.searchConversation.error', {
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

    return [new SearchConversationTool()];
}
