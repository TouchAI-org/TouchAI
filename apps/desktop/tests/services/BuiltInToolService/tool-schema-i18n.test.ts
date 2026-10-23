import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { builtInToolRegistry } from '@/services/BuiltInToolService/registry';

const CHINESE_TEXT_RE = /\p{Script=Han}/u;

function schemaSnapshot() {
    return Object.fromEntries(
        builtInToolRegistry
            .list()
            .map(
                (tool) =>
                    [
                        tool.id,
                        {
                            description: tool.description,
                            schema: tool.inputSchema,
                        },
                    ] as const
            )
            .sort(([left], [right]) => left.localeCompare(right))
    );
}

describe('user gets the same tool behaviour whatever the UI language is', () => {
    it('user sees model-facing tool schemas stay stable across UI locales', () => {
        setLocale('zh-CN');
        const zhSnapshot = schemaSnapshot();

        setLocale('en-US');
        const enSnapshot = schemaSnapshot();

        expect(enSnapshot).toEqual(zhSnapshot);
    });

    it('user sees model-facing tool descriptions stay in English', () => {
        expect(JSON.stringify(schemaSnapshot())).not.toMatch(CHINESE_TEXT_RE);
    });
});
