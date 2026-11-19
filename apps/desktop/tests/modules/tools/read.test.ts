import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBuiltinRegistrations, createReadTools, createTools } from '@/modules/tools';

const paths = vi.hoisted(() => ({ desktop: 'C:/fixture-desktop' }));
vi.mock('@tauri-apps/api/path', () => ({
    isAbsolute: async (path: string) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/'),
    desktopDir: async () => paths.desktop,
    resolve: async (...parts: string[]) => parts.join('/'),
    dirname: async (path: string) => path.slice(0, path.lastIndexOf('/')),
    basename: async (path: string) => path.slice(path.lastIndexOf('/') + 1),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
    stat: async () => ({ isDirectory: true, size: 0 }),
    readDir: async () => [{ name: 'fixture.txt', isDirectory: false, isSymlink: false }],
    open: async () => {
        throw new Error('Fixture does not contain binary files');
    },
    readTextFileLines: async () => [],
}));

afterEach(() => {
    paths.desktop = 'C:/fixture-desktop';
    closeTestDatabases();
});

describe('given local reads use the same scoped defaults as their approval', () => {
    it('user reads the approved path rather than a changed Desktop default after approval', async () => {
        routeQueriesTo(openMigratedDatabase());
        const catalog = createBuiltinRegistrations(
            createReadTools({
                messages: { t: (key) => key, tt: (text) => text },
                attachments: {
                    create: async () => {
                        throw new Error('Fixture has no media');
                    },
                },
            })
        );
        await catalog.synchronize();
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot();
            const result = await snapshot.execute(
                { id: 'call', name: 'builtin__read', arguments: '{"filePath":"folder"}' },
                {
                    iteration: 0,
                    requestApproval: async (_id, approval) => {
                        expect(approval.command).toBe('C:/fixture-desktop/folder');
                        paths.desktop = 'D:/changed-default';
                        return true;
                    },
                }
            );
            expect(result.isError).toBe(false);
            expect(result.result).toContain('<path>C:/fixture-desktop/folder</path>');
            expect(result.result).toContain('fixture.txt');
            expect(result.result).not.toContain('changed-default');
        } finally {
            tools.dispose();
        }
    });

    it('user refuses a local read without exposing content when its approval is rejected', async () => {
        routeQueriesTo(openMigratedDatabase());
        const catalog = createBuiltinRegistrations(
            createReadTools({
                messages: { t: (key) => key, tt: (text) => text },
                attachments: {
                    create: async () => {
                        throw new Error('Fixture has no media');
                    },
                },
            })
        );
        await catalog.synchronize();
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const result = await (
                await tools.snapshot()
            ).execute(
                { id: 'call', name: 'builtin__read', arguments: '{"filePath":"folder"}' },
                {
                    iteration: 0,
                    requestApproval: async () => false,
                }
            );
            expect(result).toMatchObject({
                result: 'approval_rejected',
                isError: true,
                sideEffect: 'none',
            });
            expect(result.result).not.toContain('fixture.txt');
            expect(result.attachments).toBeUndefined();
        } finally {
            tools.dispose();
        }
    });
});
