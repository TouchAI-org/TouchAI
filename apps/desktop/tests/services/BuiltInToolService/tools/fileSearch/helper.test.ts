import { describe, expect, it } from 'vitest';

import { buildEverythingQuery } from '@/services/BuiltInToolService/tools/fileSearch/helper';

describe('buildEverythingQuery', () => {
    it('escapes quotes and backslashes inside quoted search values', () => {
        const { everythingQuery } = buildEverythingQuery({
            query: '*',
            limit: 10,
            includeShortcutFiles: false,
            exactPhrase: 'C:\\Users\\"Me"',
            parentPath: 'D:\\Project Files\\TouchAI',
        });

        expect(everythingQuery).toContain(String.raw`"C:\\Users\\\"Me\""`);
        expect(everythingQuery).toContain(String.raw`parent:"D:\\Project Files\\TouchAI"`);
    });
});
