import { emit } from '@tauri-apps/api/event';
import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AppEvent, type McpServerStatus } from '@/app/api/tools/events';
import type { McpServerEntity } from '@/app/api/tools/mcpAdministration';
import { setLocale } from '@/i18n';
import { useMcpStore } from '@/stores/mcp';
import McpServerCard from '@/views/SettingsView/components/McpTools/components/McpServerCard.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
const wrappers: VueWrapper[] = [];
function server(overrides: Partial<McpServerEntity> = {}): McpServerEntity {
    return {
        id: 1,
        name: 'filesystem',
        transport_type: 'stdio',
        command: null,
        args: null,
        env: null,
        cwd: null,
        url: null,
        headers: null,
        enabled: 1,
        tool_timeout: 30,
        version: null,
        last_error: null,
        last_connected_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

function mountCard(props: { server?: McpServerEntity; selected?: boolean } = {}) {
    const wrapper = mount(McpServerCard, {
        ...fixture.viewOptions,
        props: { server: server(), selected: false, ...props },
    });
    wrappers.push(wrapper);
    return wrapper;
}
async function broadcastStatus(status: McpServerStatus) {
    await emit(AppEvent.MCP_STATUS, { serverId: 1, status, error: null });
    await flushPromises();
}
async function answerDeletion(wrapper: VueWrapper, answer: 'Delete' | 'Cancel') {
    const request = (wrapper.vm as unknown as { handleDelete: () => Promise<void> }).handleDelete();
    await flushPromises();
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('filesystem');
    const button = [...dialog.querySelectorAll('button')].find(
        (element) => element.textContent?.trim() === answer
    );
    expect(button).toBeDefined();
    button!.click();
    await request;
    await flushPromises();
}

beforeEach(async () => {
    fixture = await createSettingsPanelFixture();
    setLocale('en-US');
    const catalog = fixture.runWithContext(() => useMcpStore(fixture.pinia));
    await catalog.initialize();
    await broadcastStatus('connected');
});
afterEach(async () => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    await fixture.dispose();
    document.body.innerHTML = '';
    setLocale('zh-CN');
});

describe('given a saved MCP server in settings', () => {
    it('user opens its card and sees the server name', () => {
        expect(mountCard().text()).toContain('filesystem');
    });

    it('user toggles the server and its id is reported', async () => {
        const wrapper = mountCard({ server: server({ id: 7 }) });
        await wrapper.get('[role="switch"]').trigger('click');
        expect(wrapper.emitted('toggle-enabled')).toEqual([[7]]);
    });

    it('user confirms the named server deletion and the delete is reported', async () => {
        const wrapper = mountCard();
        await answerDeletion(wrapper, 'Delete');
        expect(wrapper.emitted('delete')).toHaveLength(1);
    });

    it('user cancels the named server deletion and nothing is deleted', async () => {
        const wrapper = mountCard();
        await answerDeletion(wrapper, 'Cancel');
        expect(wrapper.emitted('delete')).toBeUndefined();
    });

    it.each([
        ['connected', '.bg-green-500'],
        ['connecting', '.bg-yellow-500'],
        ['error', '.bg-red-500'],
    ] as const)(
        'user receives the %s connection state and sees the matching indicator',
        async (status, color) => {
            const wrapper = mountCard();
            await broadcastStatus(status);
            expect(wrapper.find(color).exists()).toBe(true);
        }
    );

    it('user opens an unknown server and sees a disconnected indicator', () => {
        expect(
            mountCard({ server: server({ id: 99 }) })
                .find('.bg-gray-400')
                .exists()
        ).toBe(true);
    });

    it('user views each transport and sees its label', () => {
        for (const [transport, label] of [
            ['stdio', 'Stdio'],
            ['sse', 'SSE'],
            ['http', 'HTTP'],
        ] as const) {
            expect(mountCard({ server: server({ transport_type: transport }) }).text()).toContain(
                label
            );
        }
    });

    it('user opens the card context menu and the application receives the event without the browser menu', async () => {
        const wrapper = mountCard();
        await wrapper.get('button').trigger('contextmenu');
        const events = wrapper.emitted('context-menu');
        expect(events).toHaveLength(1);
        expect((events![0]![0] as MouseEvent).defaultPrevented).toBe(true);
    });

    it('user selects a card and sees it marked to match the detail pane', () => {
        expect(mountCard({ selected: true }).classes()).toContain('settings-item-selected');
        expect(mountCard({ selected: false }).classes()).toContain('settings-item-unselected');
    });
});
