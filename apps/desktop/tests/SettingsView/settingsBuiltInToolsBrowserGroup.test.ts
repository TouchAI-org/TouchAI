import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toolSettingsApiKey } from '@/app/api/settings/tools';
import { toolsAdministrationApiKey } from '@/app/api/tools/administration';
import { initializeAgentWindow } from '@/app/bootstrap/agent';
import { setLocale } from '@/i18n';
import SettingsBuiltInToolsSection from '@/views/SettingsView/components/BuiltInTools/index.vue';

let fixture: ReturnType<typeof createAgentWindowFixture>;
let client: ReturnType<typeof initializeAgentWindow>;
let wrapper: VueWrapper | undefined;
let refuseUpdate = false;

beforeEach(async () => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
    setLocale('en-US');
    refuseUpdate = false;
    fixture = createAgentWindowFixture('main', undefined, {
        beforeQuery({ sql }) {
            if (refuseUpdate && sql.startsWith('update "built_in_tools"')) {
                throw new Error('fixture storage unavailable');
            }
        },
    });
    await fixture.window.ready;
    await fixture.window.capabilities.waitForAgent();
    fixture.database
        .exec(`DELETE FROM built_in_tools WHERE tool_id NOT IN ('browser', 'bash', 'computer_use');
        UPDATE built_in_tools SET display_name = 'Browser' WHERE tool_id = 'browser';
        UPDATE built_in_tools SET display_name = 'Shell' WHERE tool_id = 'bash';
        UPDATE built_in_tools SET display_name = 'Computer' WHERE tool_id = 'computer_use';`);
    mockWindows('settings');
    client = initializeAgentWindow();
});

afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await client.dispose();
    await fixture.window.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function openPanel() {
    wrapper = mount(SettingsBuiltInToolsSection, {
        global: {
            provide: {
                [toolsAdministrationApiKey as symbol]: client.tools,
                [toolSettingsApiKey as symbol]: client.toolSettings!,
            },
        },
    });
    await flushPromises();
    return wrapper;
}

function toolRow(panel: VueWrapper, name: string) {
    const heading = panel.findAll('h3').find((candidate) => candidate.text() === name);
    if (!heading) throw new Error(`Missing visible tool: ${name}`);
    return new DOMWrapper(heading.element.closest('.cursor-pointer')!);
}

function savedTool(toolId: string) {
    return fixture.database
        .prepare('SELECT enabled, config_json FROM built_in_tools WHERE tool_id = ?')
        .get(toolId);
}

describe('given settings administers the one production tools owner', () => {
    it('user disables browser automation and sees its committed choice without changing other tools', async () => {
        const panel = await openPanel();
        await toolRow(panel, 'Browser').get('[role="switch"]').trigger('click');
        await flushPromises();
        expect(savedTool('browser')).toMatchObject({ enabled: 0 });
        expect(savedTool('bash')).toMatchObject({ enabled: 1 });
        expect(toolRow(panel, 'Browser').get('[role="switch"]').attributes('aria-checked')).toBe(
            'false'
        );
    });

    it('user selects browser automation and sees logs without a second browser configuration', async () => {
        const browserBefore = savedTool('browser');
        const panel = await openPanel();
        await toolRow(panel, 'Browser').trigger('click');
        await flushPromises();
        expect(panel.text()).toContain('Call logs');
        expect(panel.find('input[type="number"]').exists()).toBe(false);
        expect(savedTool('browser')).toEqual(browserBefore);
    });

    it('user changes the shell timeout and only that tool receives the serialized configuration', async () => {
        vi.useFakeTimers();
        const browserBefore = savedTool('browser');
        const panel = await openPanel();
        await toolRow(panel, 'Shell').trigger('click');
        await panel.get('input[type="number"][min="0"]').setValue('15000');
        await vi.advanceTimersByTimeAsync(450);
        await flushPromises();
        expect(JSON.parse(String(savedTool('bash')?.config_json))).toMatchObject({
            timeoutMs: 15000,
        });
        expect(savedTool('browser')).toEqual(browserBefore);
    });

    it('user selects computer control and sees logs without duplicate configuration', async () => {
        const panel = await openPanel();
        await toolRow(panel, 'Computer').trigger('click');
        await flushPromises();
        expect(panel.text()).toContain('Call logs');
        expect(panel.find('input[type="number"]').exists()).toBe(false);
        expect(panel.text()).not.toContain('Configuration coming soon');
    });

    it('user sees a rejected toggle remain enabled and can save after storage recovers', async () => {
        const panel = await openPanel();
        refuseUpdate = true;
        await toolRow(panel, 'Browser').get('[role="switch"]').trigger('click');
        await flushPromises();
        expect(savedTool('browser')).toMatchObject({ enabled: 1 });
        expect(toolRow(panel, 'Browser').get('[role="switch"]').attributes('aria-checked')).toBe(
            'true'
        );
        refuseUpdate = false;
        await toolRow(panel, 'Browser').get('[role="switch"]').trigger('click');
        await flushPromises();
        expect(savedTool('browser')).toMatchObject({ enabled: 0 });
    });

    it('user opens tools after main closes and receives no local database fallback', async () => {
        vi.useFakeTimers();
        await fixture.window.dispose();
        const panel = await openPanel();
        await vi.advanceTimersByTimeAsync(5_000);
        await flushPromises();
        expect(panel.findAll('h3').map((heading) => heading.text())).not.toContain('Browser');
        expect(savedTool('browser')).toMatchObject({ enabled: 1 });
    });
});
