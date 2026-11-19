import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { createBrowserTools, createBuiltinRegistrations, createTools } from '@/modules/tools';

afterEach(closeTestDatabases);

async function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    const catalog = createBuiltinRegistrations(
        createBrowserTools({ messages: { t: (key) => key, tt: (text) => text } })
    );
    await catalog.synchronize();
    const tools = createTools({
        registrations: catalog.registrations,
        formatError: (code) => code,
    });
    return { database, tools };
}

describe('given browser automation uses the controlled ordinary builtin pipeline', () => {
    it('user starts the captured homepage and fingerprint rather than settings edited during approval', async () => {
        const { database, tools } = await fixture();
        database.exec(
            `INSERT INTO settings (key, value) VALUES ('browser_settings', '{"defaultHomepage":"https://first.invalid","fingerprintLocale":"en-US"}')`
        );
        mockTauriCommand('browser_start', { status: 'started' });
        try {
            const snapshot = await tools.snapshot();
            const outcome = await snapshot.execute(
                {
                    id: 'start',
                    name: 'builtin__browser',
                    arguments: '{"operation":"start","description":"Open homepage"}',
                },
                {
                    iteration: 0,
                    requestApproval: async () => {
                        database.exec(
                            `UPDATE settings SET value = '{"defaultHomepage":"https://second.invalid","fingerprintLocale":"zh-CN"}' WHERE key = 'browser_settings'`
                        );
                        return true;
                    },
                }
            );
            expect(outcome.isError).toBe(false);
            expect(getTauriInvokeCalls('browser_start').map((call) => call.payload)).toEqual([
                {
                    request: expect.objectContaining({
                        startupUrl: 'https://first.invalid',
                        fingerprintLocale: 'en-US',
                    }),
                },
            ]);
        } finally {
            tools.dispose();
        }
    });

    it('user cannot navigate when domain authorization is revoked during approval', async () => {
        const { database, tools } = await fixture();
        try {
            const snapshot = await tools.snapshot();
            const outcome = await snapshot.execute(
                {
                    id: 'navigate',
                    name: 'builtin__browser',
                    arguments:
                        '{"operation":"navigate","url":"https://public.invalid/path","description":"Open public page"}',
                },
                {
                    iteration: 0,
                    requestApproval: async () => {
                        database.exec(
                            `INSERT INTO settings (key, value) VALUES ('browser_settings', '{"blockedDomains":[{"domain":"public.invalid"}]}')`
                        );
                        return true;
                    },
                }
            );
            expect(outcome.isError).toBe(true);
            expect(getTauriInvokeCalls('browser_navigate')).toEqual([]);
        } finally {
            tools.dispose();
        }
    });

    it('user receives a screenshot attachment without inline bytes or credential-bearing URLs in model text', async () => {
        const { tools } = await fixture();
        mockTauriCommand('browser_observe', {
            path: 'C:\\fixture\\capture.png',
            base64: 'fixture-pixels',
            url: 'https://person:fixture-password@public.invalid/page?token=fixture-secret#fragment',
            width: 600,
            height: 400,
        });
        try {
            const outcome = await (
                await tools.snapshot()
            ).execute(
                {
                    id: 'capture',
                    name: 'builtin__browser',
                    arguments: '{"operation":"screenshot","description":"Capture page"}',
                },
                { iteration: 0, requestApproval: async () => true }
            );
            expect(outcome).toMatchObject({
                isError: false,
                attachments: [
                    { name: 'capture.png', type: 'image', path: 'C:\\fixture\\capture.png' },
                ],
            });
            expect(outcome.result).toContain('attachment:capture.png');
            expect(outcome.result).not.toMatch(
                /fixture-pixels|fixture-password|fixture-secret|fragment/
            );
        } finally {
            tools.dispose();
        }
    });
});
