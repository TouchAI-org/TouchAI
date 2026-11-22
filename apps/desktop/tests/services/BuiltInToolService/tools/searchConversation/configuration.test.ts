import { describe, expect, it } from 'vitest';

import {
    DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG,
    parseSearchConversationToolConfig,
    serializeSearchConversationToolConfig,
} from '@/modules/tools';

describe('given conversation search uses the existing builtin JSON configuration', () => {
    it('user gets conversation search enabled by default for missing, empty, or malformed configuration', () => {
        expect(parseSearchConversationToolConfig(null)).toEqual(
            DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG
        );
        expect(parseSearchConversationToolConfig('{}')).toEqual(
            DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG
        );
        expect(parseSearchConversationToolConfig('invalid-json')).toEqual(
            DEFAULT_SEARCH_CONVERSATION_TOOL_CONFIG
        );
    });

    it('user can persist and restore an explicit disabled switch without a schema change', () => {
        const serialized = serializeSearchConversationToolConfig({ enabled: false });

        expect(serialized).toBe('{"enabled":false}');
        expect(parseSearchConversationToolConfig(serialized)).toEqual({ enabled: false });
    });
});
