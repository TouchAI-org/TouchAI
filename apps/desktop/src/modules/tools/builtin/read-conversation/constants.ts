import type { AiToolDefinition } from '../../contracts/events';

export const READ_CONVERSATION_TOOL_NAME = 'ReadConversation';
export const READ_CONVERSATION_DEFAULT_LIMIT = 20;
export const READ_CONVERSATION_MAX_LIMIT = 50;
export const READ_CONVERSATION_DEFAULT_MAX_CHARS = 1500;
export const READ_CONVERSATION_MIN_MAX_CHARS = 50;
export const READ_CONVERSATION_MAX_MAX_CHARS = 8000;
export const READ_CONVERSATION_MAX_BYTES = 50 * 1024;
export const READ_CONVERSATION_MAX_TITLE_CODE_POINTS = 200;

export const READ_CONVERSATION_TOOL_DESCRIPTION = [
    'Read one saved conversation by session id, starting from a message returned by SearchConversation.',
    'direction "before" walks toward older messages, "after" toward newer ones; every call is bounded by limit, max_chars_per_message and 50 KiB of serialized output.',
    'Only user and assistant text is returned; system and tool content are never exposed.',
    'Use next_cursor from the previous call to keep reading in the same direction.',
].join(' ');

export const READ_CONVERSATION_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        session_id: {
            type: 'string',
            description: 'Required session id returned by SearchConversation.',
        },
        message_id: {
            type: 'integer',
            minimum: 1,
            description:
                'Optional anchor message id. Omit to start from the newest (direction "before") or oldest (direction "after") eligible message.',
        },
        direction: {
            type: 'string',
            enum: ['before', 'after'],
            default: 'before',
            description: 'Walk toward older messages ("before") or newer messages ("after").',
        },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: READ_CONVERSATION_MAX_LIMIT,
            default: READ_CONVERSATION_DEFAULT_LIMIT,
            description: `Maximum messages to return. Defaults to ${READ_CONVERSATION_DEFAULT_LIMIT}; maximum ${READ_CONVERSATION_MAX_LIMIT}.`,
        },
        max_chars_per_message: {
            type: 'integer',
            minimum: READ_CONVERSATION_MIN_MAX_CHARS,
            maximum: READ_CONVERSATION_MAX_MAX_CHARS,
            default: READ_CONVERSATION_DEFAULT_MAX_CHARS,
            description: `Per-message character cap. Defaults to ${READ_CONVERSATION_DEFAULT_MAX_CHARS}; maximum ${READ_CONVERSATION_MAX_MAX_CHARS}.`,
        },
        role: {
            type: 'string',
            enum: ['user', 'assistant'],
            description: 'Optional role filter. Omitted returns both user and assistant messages.',
        },
    },
    required: ['session_id'],
    additionalProperties: false,
};
