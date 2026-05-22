import { describe, expect, it } from 'vitest';

import { FILE_SEARCH_TOOL_DESCRIPTION } from '@/services/BuiltInToolService/tools/fileSearch/constants';

describe('FILE_SEARCH_TOOL_DESCRIPTION', () => {
    it('restricts fileSearch to name/path lookup only', () => {
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('NAME or PATH');
    });

    it('cross-references rg via Bash for content search', () => {
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('rg');
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('Bash');
    });

    it('explicitly discourages using fileSearch for content search', () => {
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('Do NOT');
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('content');
    });
});
