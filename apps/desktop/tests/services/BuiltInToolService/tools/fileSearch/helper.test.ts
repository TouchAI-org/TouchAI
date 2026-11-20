import { createFileSearchToolsFixture } from '@tests/utils/fileSearchTools';
import { describe, expect, it } from 'vitest';
const { buildEverythingQuery } = createFileSearchToolsFixture();

describe('user searches file names containing special characters', () => {
    it('user sees quotes and backslashes escaped inside quoted search values', () => {
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
