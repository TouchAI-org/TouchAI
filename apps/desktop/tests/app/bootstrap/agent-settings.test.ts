import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture, network, response } from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { createPinia, disposePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';

import { selectToolCalls } from '@/app/api/agent/history';
import { toolSettingsApiKey } from '@/app/api/settings/tools';
import { initializeAgentWindow } from '@/app/bootstrap/agent';

let fixture: ReturnType<typeof createAgentWindowFixture>;
beforeEach(async () => {
    fixture = createAgentWindowFixture();
    mockTauriCommand('is_autostart_enabled', false);
    await fixture.window.ready;
});
afterEach(async () => {
    await fixture.window.dispose();
});

describe('given preferences belong to production main and views are bounded clients', () => {
    it('user changes a preference in settings and an approved Agent tool sees the same committed value', async () => {
        await fixture.window.settings.initialize();
        mockWindows('settings');
        const client = initializeAgentWindow();
        try {
            await client.settings.initialize();
            expect(
                (await client.settings.mutate('output_scroll_behavior', 'stay_position')).status
            ).toBe('committed');
            network.replies.push(
                response('', false, {
                    name: 'builtin__setting',
                    arguments: JSON.stringify({
                        action: 'get',
                        keys: ['output_scroll_behavior'],
                    }),
                }),
                response('same saved preference')
            );
            const task = await fixture.window.api.startTask({
                prompt: 'read the changed preference',
            });
            expect((await task.completion).response).toBe('same saved preference');
            expect(JSON.stringify(network.requests[1])).toContain('stay_position');
            expect(fixture.window.settings.getSnapshot().outputScrollBehavior).toBe(
                'stay_position'
            );
            expect(
                fixture.database
                    .prepare("SELECT value FROM settings WHERE key = 'output_scroll_behavior'")
                    .get()
            ).toEqual({ value: 'stay_position' });
        } finally {
            await client.dispose();
        }
    });

    it('user reads ordinary preferences without receiving saved tool credentials or executable configuration', async () => {
        fixture.database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
            'search_settings',
            JSON.stringify({
                providers: { brave: { enabled: true, apiKey: 'tool-credential-marker' } },
            })
        );
        await fixture.window.settings.initialize();
        mockWindows('tray-menu');
        const ordinary = initializeAgentWindow();
        try {
            await ordinary.settings.initialize();
            const snapshot = ordinary.settings.getSnapshot();
            expect(Object.keys(snapshot)).not.toEqual(
                expect.arrayContaining(['searchSettings', 'browserSettings'])
            );
            expect(JSON.stringify(snapshot)).not.toMatch(
                /tool-credential-marker|fixture-secret|apiKey|api_endpoint/
            );
            expect(ordinary.toolSettings).toBeUndefined();
            const payloads = getTauriInvokeCalls('plugin:event|emit_to').map(
                (call) => call.payload
            );
            expect(
                JSON.stringify(
                    payloads.filter((payload) => JSON.stringify(payload).includes('tray-menu'))
                )
            ).not.toContain('tool-credential-marker');
        } finally {
            await ordinary.dispose();
        }
    });

    it('user receives settings administration through main without copying its saved secrets to another window', async () => {
        fixture.database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
            'search_settings',
            JSON.stringify({
                providers: { brave: { enabled: true, apiKey: 'tools-only-secret' } },
            })
        );
        await fixture.window.settings.initialize();
        mockWindows('settings');
        const client = initializeAgentWindow();
        try {
            await client.settings.initialize();
            expect(client.toolSettings!.getSearchSettings().providers.brave.apiKey).toBe(
                'tools-only-secret'
            );
            expect(JSON.stringify(client.settings.getSnapshot())).not.toContain(
                'tools-only-secret'
            );
            const next = client.toolSettings!.getSearchSettings();
            next.maxResults = 4;
            await client.toolSettings!.updateSearchSettings(next);
            expect(
                JSON.parse(
                    String(
                        fixture.database
                            .prepare("SELECT value FROM settings WHERE key = 'search_settings'")
                            .get()?.value
                    )
                )
            ).toMatchObject({
                maxResults: 4,
                providers: { brave: { apiKey: 'tools-only-secret' } },
            });
            await expect(
                client.api.startTask({ prompt: 'no secondary writer or execution' })
            ).rejects.toMatchObject({ code: 'MAIN_EXECUTION_HOST_REQUIRED' });
        } finally {
            await client.dispose();
        }
    });

    it('user closes main and a client fails rather than writing locally or reviving its owner', async () => {
        vi.useFakeTimers();
        await fixture.window.settings.initialize();
        mockWindows('settings');
        const client = initializeAgentWindow();
        try {
            await client.settings.initialize();
            await fixture.window.dispose();
            await expect(
                client.settings.mutate('output_scroll_behavior', 'stay_position')
            ).rejects.toMatchObject({ code: 'settings-owner-unavailable' });
            expect(
                fixture.database
                    .prepare("SELECT value FROM settings WHERE key = 'output_scroll_behavior'")
                    .get()
            ).toEqual({ value: 'follow_output' });
        } finally {
            await client.dispose();
        }
    });

    it('user detaches a tool settings projection without closing the main writer or another client', async () => {
        await fixture.window.settings.initialize();
        mockWindows('settings');
        const client = initializeAgentWindow();
        const pinia = createPinia();
        const app = createApp({ render: () => null });
        app.use(pinia);
        app.provide(toolSettingsApiKey, client.toolSettings!);
        try {
            const { useToolSettingsStore } = await import('@/stores/toolSettings');
            const store = app.runWithContext(() => useToolSettingsStore(pinia));
            await store.initialize();
            const incoming = fixture.window.toolSettings!.getBrowserSettings();
            incoming.headless = false;
            await fixture.window.toolSettings!.updateBrowserSettings(incoming);
            await vi.waitFor(() => expect(store.browserSettings.headless).toBe(false));
            disposePinia(pinia);
            await client.toolSettings!.updateBrowserSettings({ ...incoming, headless: true });
            expect(fixture.window.toolSettings!.getBrowserSettings().headless).toBe(true);
            expect(
                fixture.database
                    .prepare("SELECT value FROM settings WHERE key = 'browser_settings'")
                    .get()
            ).toMatchObject({ value: expect.stringContaining('"headless":true') });
        } finally {
            disposePinia(pinia);
            await client.dispose();
        }
    });

    it('user disables a builtin in settings and the next production turn cannot declare or execute it', async () => {
        await fixture.window.capabilities.waitForAgent();
        mockWindows('settings');
        const client = initializeAgentWindow();
        try {
            const saved = (await client.tools.findAllBuiltInTools()).find(
                (tool) => tool.tool_id === 'web_search'
            )!;
            expect(saved.enabled).toBe(1);
            await client.tools.updateBuiltInTool(saved.id, { enabled: 0 });
            network.replies.push(
                response('', false, {
                    name: 'builtin__web_search',
                    arguments: '{"query":"disabled"}',
                }),
                response('search is disabled')
            );
            const task = await fixture.window.api.startTask({
                prompt: 'respect the saved tool selection',
            });
            expect((await task.completion).response).toBe('search is disabled');
            expect(
                (network.requests[0]!.tools as { function: { name: string } }[]).map(
                    (tool) => tool.function.name
                )
            ).not.toContain('builtin__web_search');
            expect(
                fixture.window.api
                    .getTaskSnapshot(task.taskId)!
                    .sessionHistory.flatMap(selectToolCalls)
            ).toContainEqual(
                expect.objectContaining({ namespacedName: 'builtin__web_search', isError: true })
            );
            expect(
                fixture.database
                    .prepare("SELECT enabled FROM built_in_tools WHERE tool_id = 'web_search'")
                    .get()
            ).toEqual({ enabled: 0 });
            mockWindows('tray-menu');
            const ordinary = initializeAgentWindow();
            try {
                await expect(ordinary.tools.findAllBuiltInTools()).rejects.toMatchObject({
                    code: 'TOOLS_COMMAND_UNAVAILABLE',
                });
            } finally {
                await ordinary.dispose();
            }
        } finally {
            await client.dispose();
        }
    });
});
