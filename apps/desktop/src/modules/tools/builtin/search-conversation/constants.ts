import type { AiToolDefinition } from '../../contracts/events';

export const SEARCH_CONVERSATION_TOOL_NAME = 'SearchConversation';
export const CONVERSATION_SEARCH_CANDIDATE_LIMIT = 100;
export const CONVERSATION_SEARCH_DEFAULT_LIMIT = 10;
export const CONVERSATION_SEARCH_MAX_LIMIT = 50;
export const CONVERSATION_SEARCH_DEFAULT_RERANK = false;
export const CONVERSATION_SEARCH_MESSAGES_PER_EDGE = 50;
export const CONVERSATION_SEARCH_MAX_TRANSCRIPT_CODE_POINTS = 2000;
export const CONVERSATION_SEARCH_MAX_BATCH_BYTES = 50 * 1024;
export const CONVERSATION_SEARCH_MAX_SNIPPETS = 3;
export const CONVERSATION_SEARCH_SNIPPET_CONTEXT_CODE_POINTS = 50;
export const CONVERSATION_SEARCH_RANKING_DEADLINE_MS = 8000;
export const CONVERSATION_SEARCH_MAX_RANKING_OUTPUT_TOKENS = 512;

export const SEARCH_CONVERSATION_TOOL_DESCRIPTION = [
    'Search the user’s saved conversation history by literal keywords in session titles and user/assistant message text.',
    'Results carry match anchors (message_id plus a short snippet); pass one to ReadConversation to load surrounding messages in either direction.',
    'Reranking with the current task model is opt-in via rerank and only reorders the keyword candidates.',
    'Sessions that express the same idea with different words can only be returned when the keyword phase found some matching text; this tool does not perform query expansion or embedding search.',
    'Date-only filters use the local calendar day and include the whole day. Archived sessions are included.',
].join(' ');

export const SEARCH_CONVERSATION_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description:
                'Required literal keywords or natural-language query used for the database keyword phase.',
        },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: CONVERSATION_SEARCH_MAX_LIMIT,
            default: CONVERSATION_SEARCH_DEFAULT_LIMIT,
            description: `Maximum sessions to return. Defaults to ${CONVERSATION_SEARCH_DEFAULT_LIMIT}; maximum ${CONVERSATION_SEARCH_MAX_LIMIT}.`,
        },
        from_date: {
            type: 'string',
            description:
                'Optional ISO-8601 date or timestamp. A date-only value means the full local calendar day and is inclusive.',
        },
        to_date: {
            type: 'string',
            description:
                'Optional ISO-8601 date or timestamp. A date-only value includes that entire local calendar day.',
        },
        model: {
            type: 'string',
            description: 'Optional exact, case-insensitive session model filter.',
        },
        role: {
            type: 'string',
            enum: ['user', 'assistant'],
            description:
                'Optional message-role filter. Titles always participate; omitted searches both user and assistant messages.',
        },
        rerank: {
            type: 'boolean',
            default: CONVERSATION_SEARCH_DEFAULT_RERANK,
            description:
                'Optional. Rerank keyword candidates with the current task model. Slower and consumes tokens; defaults to false.',
        },
    },
    required: ['query'],
    additionalProperties: false,
};
