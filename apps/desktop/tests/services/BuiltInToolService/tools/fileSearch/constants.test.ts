import { describe, expect, it } from 'vitest';

import { FILE_SEARCH_TOOL_DESCRIPTION } from '@/services/BuiltInToolService/tools/fileSearch/constants';

describe('user searches for files by name', () => {
    it('user sees file search restricted to name and path lookup', () => {
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('NAME or PATH');
    });

    it('user sees content search pointed at rg through the shell tool', () => {
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('rg');
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('Bash');
    });

    it('user sees file search explicitly discouraged for content search', () => {
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('Do NOT');
        expect(FILE_SEARCH_TOOL_DESCRIPTION).toContain('content');
    });
});
