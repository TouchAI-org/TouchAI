import { describe, expect, it } from 'vitest';

import { TOUCHAI_BUILTIN_SYSTEM_PROMPT } from '@/services/AgentService/prompt/builtin';
import { webFetchTool } from '@/services/BuiltInToolService/tools/webFetch';

describe('web tool ordering prompt', () => {
    it('tells the model to call real web_search for discovery instead of fetching search result pages', () => {
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('builtin__web_search');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain('builtin__web_fetch');
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Never simulate `builtin__web_search` by fetching search result pages'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Only fetch a search-results URL when the user explicitly asks to read that exact URL'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            'Choose `builtin__web_search.provider` deliberately'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            '`anysearch` is the recommended general default'
        );
        expect(TOUCHAI_BUILTIN_SYSTEM_PROMPT).toContain(
            '`auto` follows user settings and normally resolves to `anysearch`'
        );
    });

    it('describes web_fetch as reading known URLs, not discovery', () => {
        expect(webFetchTool.description).toContain('known public web pages');
        expect(webFetchTool.description).toContain('builtin__web_search for discovery');
        expect(JSON.stringify(webFetchTool.inputSchema)).toContain(
            'For discovery, call builtin__web_search'
        );
    });
});
