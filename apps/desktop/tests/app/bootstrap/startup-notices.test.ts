import { mockWindows } from '@tauri-apps/api/mocks';
import { describe, expect, it, vi } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';
import { setLocale } from '@/i18n';

import { createAgentWindowFixture } from '../../utils/agentWindow';
import { mockTauriCommand } from '../../utils/tauri';

const notifications = vi.hoisted(() => [] as Array<{ title: string; body: string }>);
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: (notice: { title: string; body: string }) => {
        notifications.push(notice);
    },
}));

describe('given production main owns saved restart notices', () => {
    it.each(['chat_only', 'full'] as const)(
        'user consumes a %s import notice once after main has loaded the active language',
        async (mode) => {
            const fixture = createAgentWindowFixture();
            fixture.database
                .prepare('INSERT INTO touchai_meta (key, value) VALUES (?, ?)')
                .run(
                    'import_success',
                    JSON.stringify({ type: 'import-success', version: 1, importMode: mode })
                );
            fixture.database
                .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
                .run('language', 'en-US');
            await fixture.window.ready;
            await Promise.all([
                fixture.window.startup!.consume(),
                fixture.window.startup!.consume(),
            ]);
            expect(
                fixture.database
                    .prepare('SELECT value FROM touchai_meta WHERE key = ?')
                    .get('import_success')
            ).toBeUndefined();
            expect(notifications.splice(0)).toEqual([
                {
                    title: 'TouchAI',
                    body:
                        mode === 'full'
                            ? 'Data imported successfully (Overwrite settings and import conversation data incrementally)'
                            : 'Data imported successfully (Import conversation data only)',
                },
            ]);
            await fixture.window.dispose();
            setLocale('zh-CN');
        }
    );

    it('user keeps a saved marker when only Settings or a closed main client is available', async () => {
        const fixture = createAgentWindowFixture();
        fixture.database
            .prepare('INSERT INTO touchai_meta (key, value) VALUES (?, ?)')
            .run('import_success', 'legacy notice');
        await fixture.window.ready;
        mockWindows('settings');
        const settings = initializeAgentWindow();
        expect(settings.startup).toBeUndefined();
        await fixture.window.dispose();
        await fixture.window.startup!.consume();
        expect(
            fixture.database
                .prepare('SELECT value FROM touchai_meta WHERE key = ?')
                .get('import_success')?.value
        ).toBe('legacy notice');
        await settings.dispose();
    });

    it('user keeps the marker and sees no notice when native storage refuses its deletion', async () => {
        const fixture = createAgentWindowFixture();
        fixture.database
            .prepare('INSERT INTO touchai_meta (key, value) VALUES (?, ?)')
            .run('import_success', 'old notice');
        await fixture.window.ready;
        fixture.database.exec(
            "CREATE TEMP TRIGGER refuse_notice BEFORE DELETE ON touchai_meta BEGIN SELECT RAISE(ABORT, 'fixture refusal'); END"
        );
        await expect(fixture.window.startup!.consume()).resolves.toBeUndefined();
        expect(
            fixture.database
                .prepare('SELECT value FROM touchai_meta WHERE key = ?')
                .get('import_success')?.value
        ).toBe('old notice');
        expect(notifications.splice(0)).toEqual([]);
        mockTauriCommand('analytics_get_state', undefined);
        await fixture.window.dispose();
    });
});
