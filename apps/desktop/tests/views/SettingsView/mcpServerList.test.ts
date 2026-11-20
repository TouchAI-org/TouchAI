import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { useMcpAdministrationStore } from '@/stores/mcpAdministration';
import McpServerCard from '@/views/SettingsView/components/McpTools/components/McpServerCard.vue';
import McpServerList from '@/views/SettingsView/components/McpTools/components/McpServerList.vue';

let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let store: ReturnType<typeof useMcpAdministrationStore>;
const wrappers: ReturnType<typeof mount>[] = [];
afterEach(async () => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
    await fixture?.dispose();
});
function saveServers(values: ReturnType<typeof makeServer>[]) {
    fixture.database.exec('DELETE FROM mcp_servers');
    for (const value of values) {
        const keys = Object.keys(value);
        fixture.database
            .prepare(
                `INSERT INTO mcp_servers (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
            )
            .run(...Object.values(value));
    }
}
function card(wrapper: ReturnType<typeof mountList>, id: number) {
    const found = wrapper
        .findAllComponents(McpServerCard)
        .find((candidate) => candidate.props('server').id === id);
    if (!found) throw new Error(`Missing server card ${id}`);
    return found;
}

function makeServer(id: number, name = `server-${id}`) {
    return {
        args: null,
        command: 'npx',
        created_at: '2026-05-20T00:00:00.000Z',
        cwd: null,
        enabled: 1,
        env: null,
        headers: null,
        id,
        last_connected_at: null,
        last_error: null,
        name,
        tool_timeout: 30000,
        transport_type: 'stdio',
        updated_at: '2026-05-20T00:00:00.000Z',
        url: null,
        version: null,
    };
}

function mountList(props: Record<string, unknown> = {}) {
    const wrapper = mount(McpServerList, {
        ...fixture.viewOptions,
        props: { selectedServer: null, togglingServers: new Set<number>(), ...props },
    });
    wrappers.push(wrapper);
    return wrapper;
}

function selectCalls(wrapper: ReturnType<typeof mountList>) {
    return (wrapper.emitted('select') ?? []).map((call) => call[0]);
}

/** The most recent selection the list asked the parent to make. */
function lastSelect(wrapper: ReturnType<typeof mountList>) {
    const calls = selectCalls(wrapper);
    return calls[calls.length - 1];
}

beforeEach(async () => {
    fixture = await createSettingsPanelFixture();
    store = fixture.runWithContext(() => useMcpAdministrationStore(fixture.pinia));
    setLocale('zh-CN');
});

describe('user opens the server list', () => {
    it('user gets the first server selected when none was chosen yet', async () => {
        saveServers([makeServer(1), makeServer(2)]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();

        expect(selectCalls(wrapper)[0]).toMatchObject({ id: 1 });
    });

    it('user gets no automatic selection when the list is empty', async () => {
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();

        expect(selectCalls(wrapper)).toHaveLength(0);
    });

    it('user keeps their own selection instead of jumping to the first server', async () => {
        saveServers([makeServer(1), makeServer(2)]);
        await store.initialize();

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();

        expect(selectCalls(wrapper)).toHaveLength(0);
    });

    it('user gets the servers loaded when the panel is the first thing opened', async () => {
        saveServers([makeServer(1)]);

        const wrapper = mountList();
        await flushPromises();

        expect(wrapper.text()).toContain('server-1');
        expect(selectCalls(wrapper)[0]).toMatchObject({ id: 1 });
    });

    it('user sees a placeholder row for every server still loading', async () => {
        const wrapper = mountList();
        await wrapper.vm.$nextTick();

        expect(wrapper.findAll('.animate-pulse')).toHaveLength(3);
        expect(wrapper.findAllComponents(McpServerCard)).toHaveLength(0);
        await flushPromises();
    });

    it('user sees every saved server named in the list', async () => {
        saveServers([makeServer(1, 'filesystem'), makeServer(2, 'github')]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();

        expect(card(wrapper, 1).text()).toContain('filesystem');
        expect(card(wrapper, 2).text()).toContain('github');
    });

    it('user sees which server is currently open', async () => {
        saveServers([makeServer(1), makeServer(2)]);
        await store.initialize();

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();

        expect(String(card(wrapper, 1).classes().includes('settings-item-selected'))).toBe('false');
        expect(String(card(wrapper, 2).classes().includes('settings-item-selected'))).toBe('true');
    });

    it('user sees a server being switched shown as busy', async () => {
        saveServers([makeServer(1)]);
        await store.initialize();

        const wrapper = mountList({ togglingServers: new Set([1]) });
        await flushPromises();

        expect(card(wrapper, 1).get('[role="switch"]').attributes('disabled')).toBeDefined();
    });

    it('user gets the picked server forwarded when they click a card', async () => {
        saveServers([makeServer(1), makeServer(2)]);
        await store.initialize();

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();
        await card(wrapper, 1).trigger('click');

        expect(lastSelect(wrapper)).toMatchObject({ id: 1 });
    });

    it('user gets the enable switch forwarded with the server it belongs to', async () => {
        saveServers([makeServer(3)]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();
        await card(wrapper, 3).get('[role="switch"]').trigger('click');

        expect(wrapper.emitted('toggle-enabled')?.[0]).toEqual([3]);
    });

    it('user gets the delete request forwarded with the server it belongs to', async () => {
        saveServers([makeServer(4)]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();
        card(wrapper, 4).vm.$emit('delete');

        expect(wrapper.emitted('delete')?.[0]).toEqual([4]);
    });

    it('user gets the right-click forwarded so a context menu can open', async () => {
        saveServers([makeServer(5)]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();
        await card(wrapper, 5).trigger('contextmenu');

        expect(wrapper.emitted('context-menu')?.[0]?.[0]).toBe(5);
    });

    it('user gets the unsaved row dropped when they click an existing server', async () => {
        saveServers([makeServer(1), makeServer(2)]);
        await store.initialize();

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        await flushPromises();
        expect(wrapper.text()).toContain('新建服务器');

        await card(wrapper, 1).trigger('click');
        await flushPromises();

        expect(wrapper.text()).not.toContain('新建服务器');
        expect(lastSelect(wrapper)).toMatchObject({ id: 1 });
    });
});

describe('user adds a server from the list', () => {
    it('user sees a placeholder row while the new server is unsaved', async () => {
        saveServers([]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        await flushPromises();

        expect(wrapper.text()).toContain('新建服务器');
        expect(wrapper.text()).toContain('请在右侧填写服务器配置');
    });

    it('user gets the unsaved server handed to the form straight away', async () => {
        saveServers([]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        await flushPromises();

        expect(selectCalls(wrapper)[0]).toMatchObject({ id: -1, transport_type: 'stdio' });
    });

    it('user gets the first server back when they cancel the new one', async () => {
        saveServers([makeServer(1), makeServer(2)]);
        await store.initialize();

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        (wrapper.vm as unknown as { handleServerCancelled: () => void }).handleServerCancelled();
        await flushPromises();

        expect(lastSelect(wrapper)).toMatchObject({ id: 1 });
    });

    it('user gets an empty selection back when they cancel with no servers saved', async () => {
        saveServers([]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        (wrapper.vm as unknown as { handleServerCancelled: () => void }).handleServerCancelled();
        await flushPromises();

        expect(lastSelect(wrapper)).toBeNull();
    });

    it('user gets the newest server opened after saving one', async () => {
        saveServers([makeServer(1)]);
        await store.initialize();

        const wrapper = mountList({ selectedServer: makeServer(1) });
        await flushPromises();

        saveServers([makeServer(1), makeServer(2, 'just-saved')]);
        await (
            wrapper.vm as unknown as { handleServerSaved: () => Promise<void> }
        ).handleServerSaved();
        await flushPromises();

        expect(lastSelect(wrapper)).toMatchObject({ name: 'just-saved' });
    });

    it('user gets no selection when saving the very first server fails to return a list', async () => {
        saveServers([]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();
        await (
            wrapper.vm as unknown as { handleServerSaved: () => Promise<void> }
        ).handleServerSaved();
        await flushPromises();

        expect(selectCalls(wrapper)).toHaveLength(0);
    });

    it('user gets the unsaved row cleared once the new server is saved', async () => {
        saveServers([]);
        await store.initialize();

        const wrapper = mountList();
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        await flushPromises();
        saveServers([makeServer(3)]);
        await (
            wrapper.vm as unknown as { handleServerSaved: () => Promise<void> }
        ).handleServerSaved();
        await flushPromises();

        expect(wrapper.text()).not.toContain('新建服务器');
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
