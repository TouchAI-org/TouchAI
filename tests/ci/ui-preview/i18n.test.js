import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkLocaleParity, extractKeys } from '../../../.github/ui-preview/lib/i18n.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const i18nDirectory = path.resolve(testDirectory, '../../../apps/desktop/src/i18n');

describe('user reads the app in either locale', () => {
    it('user sees the same keys in zh-CN and en-US', () => {
        const result = checkLocaleParity(i18nDirectory);

        expect(result.checked).toBe(true);
        expect(result.ok).toBe(true);
    });
});

describe('user reads a locale object', () => {
    it('user gets every quoted key from the object', () => {
        const keys = extractKeys(
            `const zhCNMessages = {\n  'a.b': 'x',\n  'c.d': 'y',\n};`,
            'zhCNMessages'
        );

        expect([...keys]).toEqual(['a.b', 'c.d']);
    });

    it('user gets nothing when the object is not declared', () => {
        expect(extractKeys('const other = {};', 'zhCNMessages')).toBeNull();
    });

    it('user gets only the keys inside the object, not a later one', () => {
        const keys = extractKeys(
            `const zhCNMessages = {\n  'a': 'x',\n};\nconst enUSMessages = {\n  'b': 'y',\n};`,
            'zhCNMessages'
        );

        expect([...keys]).toEqual(['a']);
    });
});
