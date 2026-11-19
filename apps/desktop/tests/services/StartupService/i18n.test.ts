import { afterEach, describe, expect, it, vi } from 'vitest';

import { serializeImportSuccessStartupPayload } from '@/app/workflows/data-management/startup';
import { setLocale } from '@/i18n';

import { createAgentWindowFixture } from '../../utils/agentWindow';

const notifications = vi.hoisted(() => [] as Array<{ title: string; body: string }>);
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: (notice: { title: string; body: string }) => {
        notifications.push(notice);
    },
}));

afterEach(() => {
    notifications.length = 0;
    setLocale('zh-CN');
});

describe('given an import notice saved before restart', () => {
    it.each([
        [
            'en-US',
            'full',
            'Data imported successfully (Overwrite settings and import conversation data incrementally)',
        ],
        ['en-US', 'chat_only', 'Data imported successfully (Import conversation data only)'],
        ['zh-CN', 'chat_only', '数据导入成功（仅导入对话数据）'],
    ] as const)('user reads the %s %s notice after starting main', async (locale, mode, body) => {
        const fixture = createAgentWindowFixture();
        fixture.database
            .prepare('INSERT INTO touchai_meta (key, value) VALUES (?, ?)')
            .run('import_success', serializeImportSuccessStartupPayload(mode));
        fixture.database
            .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
            .run('language', locale);
        await fixture.window.ready;
        await fixture.window.startup!.consume();
        expect(notifications).toEqual([{ title: 'TouchAI', body }]);
        expect(
            fixture.database
                .prepare('SELECT value FROM touchai_meta WHERE key = ?')
                .get('import_success')
        ).toBeUndefined();
        await fixture.window.dispose();
    });

    it('user retains the existing marker bytes when saving chat-only import success', () => {
        expect(serializeImportSuccessStartupPayload('chat_only')).toBe(
            '{"type":"import-success","version":1,"importMode":"chat_only"}'
        );
    });

    it.each([
        JSON.stringify({ type: 'import-success', version: 99, importMode: 'full' }),
        JSON.stringify({ type: 'import-success', version: 1, importMode: 'settings_only' }),
        '数据导入成功（覆盖设置，差量导入对话数据）',
    ])(
        'user reads an unsupported or legacy notice as saved when restarting main: %s',
        async (body) => {
            const fixture = createAgentWindowFixture();
            fixture.database
                .prepare('INSERT INTO touchai_meta (key, value) VALUES (?, ?)')
                .run('import_success', body);
            await fixture.window.ready;
            await fixture.window.startup!.consume();
            expect(notifications).toEqual([{ title: 'TouchAI', body }]);
            await fixture.window.dispose();
        }
    );

    it('user can start again and consume the notice after native storage recovers from a read failure', async () => {
        let unavailable = false;
        const fixture = createAgentWindowFixture('main', undefined, {
            beforeQuery({ sql }) {
                if (unavailable && sql.includes('touchai_meta'))
                    throw new Error('fixture unavailable');
            },
        });
        fixture.database
            .prepare('INSERT INTO touchai_meta (key, value) VALUES (?, ?)')
            .run('import_success', 'saved notice');
        await fixture.window.ready;
        unavailable = true;
        await expect(fixture.window.startup!.consume()).resolves.toBeUndefined();
        expect(notifications).toEqual([]);
        expect(
            fixture.database
                .prepare('SELECT value FROM touchai_meta WHERE key = ?')
                .get('import_success')?.value
        ).toBe('saved notice');
        unavailable = false;
        await fixture.window.startup!.consume();
        expect(notifications).toEqual([{ title: 'TouchAI', body: 'saved notice' }]);
        await fixture.window.dispose();
    });
});
