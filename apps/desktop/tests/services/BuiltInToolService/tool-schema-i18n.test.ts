import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { builtInToolRegistry } from '@/services/BuiltInToolService/registry';

const CHINESE_TEXT_RE = /\p{Script=Han}/u;

function schemaSnapshot() {
    return Object.fromEntries(
        builtInToolRegistry
            .list()
            .map((tool) => [
                tool.id,
                {
                    description: tool.description,
                    schema: tool.inputSchema,
                },
            ] as const)
            .sort(([left], [right]) => left.localeCompare(right))
    );
}

describe('Built-in tool model schema i18n boundary', () => {
    it('keeps model-facing tool schemas stable across UI locales', () => {
        setLocale('zh-CN');
        const zhSnapshot = schemaSnapshot();

        setLocale('en-US');
        const enSnapshot = schemaSnapshot();

        expect(enSnapshot).toEqual(zhSnapshot);
    });

    it('keeps model-facing tool descriptions in English instead of UI-localized Chinese', () => {
        expect(JSON.stringify(schemaSnapshot())).not.toMatch(CHINESE_TEXT_RE);
    });
});
