import { createToolsHostFixture } from '@tests/utils/toolsHost';
import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

const CHINESE_TEXT_RE = /\p{Script=Han}/u;

async function schemaSnapshot() {
    const input = await createToolsHostFixture();
    const snapshot = await input.host.tools.snapshot({
        preparation: { taskId: input.taskId, currentModel: input.currentModel },
    });
    expect(snapshot.declarations.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
            'builtin__read',
            'builtin__bash',
            'builtin__web_fetch',
            'builtin__upgrade_model',
            'builtin__setting',
        ])
    );
    return Object.fromEntries(
        snapshot.declarations
            .map(
                (tool) =>
                    [
                        tool.name,
                        {
                            description: tool.description,
                            schema: tool.input_schema,
                        },
                    ] as const
            )
            .sort(([left], [right]) => String(left).localeCompare(String(right)))
    );
}

describe('user gets the same tool behaviour whatever the UI language is', () => {
    it('user sees model-facing tool schemas stay stable across UI locales', async () => {
        setLocale('zh-CN');
        const zhSnapshot = await schemaSnapshot();

        setLocale('en-US');
        const enSnapshot = await schemaSnapshot();

        expect(enSnapshot.builtin__read?.schema).toMatchObject({ type: 'object' });
        expect(enSnapshot).toEqual(zhSnapshot);
    });

    it('user sees model-facing tool descriptions stay in English', async () => {
        expect(JSON.stringify(await schemaSnapshot())).not.toMatch(CHINESE_TEXT_RE);
    });
});
