import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { ToolSettingsCapabilities } from '@/modules/tools';
import { createBuiltinRegistrations, createSettingTools, createTools } from '@/modules/tools';

afterEach(closeTestDatabases);

async function fixture(mutation: Awaited<ReturnType<ToolSettingsCapabilities['mutate']>>) {
    routeQueriesTo(openMigratedDatabase());
    const catalog = createBuiltinRegistrations(
        createSettingTools({
            messages: { t: (key) => key, tt: (text) => text },
            settings: { read: async () => 'en-US', mutate: async () => mutation },
        })
    );
    await catalog.synchronize();
    return createTools({ registrations: catalog.registrations, formatError: (code) => code });
}

describe('given settings effects use the single authoritative preference mutation capability', () => {
    it('user receives the existing committed settings result after approving a supported update', async () => {
        const tools = await fixture({ status: 'committed' });
        try {
            const outcome = await (
                await tools.snapshot()
            ).execute(
                {
                    id: 'set',
                    name: 'builtin__setting',
                    arguments:
                        '{"action":"set","key":"language","value":"en-US","reason":"Use English"}',
                },
                { iteration: 0, requestApproval: async () => true }
            );
            expect(outcome).toMatchObject({ isError: false, status: 'success' });
            expect(outcome.result).toContain('en-US');
        } finally {
            tools.dispose();
        }
    });

    it.each(['unknown', 'recovery-required'] as const)(
        'user keeps an uncertain side effect when the settings owner reports %s',
        async (status) => {
            const tools = await fixture({
                status,
                code: 'fixture-uncertain',
                message: 'Unconfirmed fixture update',
            });
            try {
                const outcome = await (
                    await tools.snapshot()
                ).execute(
                    {
                        id: 'set',
                        name: 'builtin__setting',
                        arguments:
                            '{"action":"set","key":"language","value":"en-US","reason":"Use English"}',
                    },
                    { iteration: 0, requestApproval: async () => true }
                );
                expect(outcome).toMatchObject({ isError: true, sideEffect: 'unknown' });
                expect(outcome.result).toContain('设置结果未确认');
            } finally {
                tools.dispose();
            }
        }
    );
});
