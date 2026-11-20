import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { describe, expect, it } from 'vitest';

import type { SettingsApi } from '@/app/api/settings/preferences';
import { initializeAgentWindow } from '@/app/bootstrap/agent';

const toolKey = 'search_settings' as Parameters<SettingsApi['readEffectiveValue']>[0];
const savedTools = JSON.stringify({
    providers: { brave: { enabled: true, apiKey: 'private-tool-credential' } },
});

async function createPreferencesClient(label: string) {
    const fixture = createAgentWindowFixture();
    fixture.database
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
        .run(toolKey, savedTools);
    await fixture.window.ready;
    await fixture.window.settings.initialize();
    mockWindows(label);
    const client = label === 'main' ? fixture.window : initializeAgentWindow();
    await client.settings.initialize();
    return {
        ...fixture,
        client,
        async dispose() {
            await client.dispose();
            await fixture.window.dispose();
        },
    };
}

describe('given an ordinary preference API beside separate tool administration', () => {
    it.each(['main', 'settings', 'tray-menu'])(
        'user cannot read tool credentials through an unexpected preference key in %s',
        async (label) => {
            const fixture = await createPreferencesClient(label);
            try {
                await expect(
                    fixture.client.settings.readEffectiveValue(toolKey)
                ).rejects.toMatchObject({
                    code: 'settings-unknown-key',
                });
                expect(
                    await fixture.client.settings.readEffectiveValue('output_scroll_behavior')
                ).toBe('follow_output');
                expect(
                    fixture.window.toolSettings!.getSearchSettings().providers.brave.apiKey
                ).toBe('private-tool-credential');
            } finally {
                await fixture.dispose();
            }
        }
    );

    it.each(['main', 'settings', 'tray-menu'])(
        'user cannot overwrite tool configuration through an unexpected preference key in %s',
        async (label) => {
            const fixture = await createPreferencesClient(label);
            try {
                await expect(fixture.client.settings.mutate(toolKey, '{}')).rejects.toMatchObject({
                    code: 'settings-unknown-key',
                });
                expect(
                    fixture.database
                        .prepare('SELECT value FROM settings WHERE key = ?')
                        .get(toolKey)
                ).toEqual({ value: savedTools });
                expect(
                    await fixture.client.settings.mutate('output_scroll_behavior', 'stay_position')
                ).toMatchObject({ status: 'committed' });
                expect(fixture.window.settings.getSnapshot().outputScrollBehavior).toBe(
                    'stay_position'
                );
            } finally {
                await fixture.dispose();
            }
        }
    );
});
