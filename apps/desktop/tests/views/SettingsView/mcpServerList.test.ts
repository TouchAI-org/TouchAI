import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import McpServerList from '@/views/SettingsView/components/McpTools/components/McpServerList.vue';

/*
 * The server list owns two pieces of state the user can feel: which server is
 * selected after loading, and the unsaved "new server" row. Both are reported to
 * the parent through `select`, so the assertions below read the emitted payload
 * rather than the internal refs.
 */

// A reactive store, because the component reads it through computed(): a plain
// object would let the first read stick and hide the reload from the assertions.
const store = await vi.hoisted(async () => {
    const { reactive } = await import('vue');
    return reactive({
        servers: [] as Array<Record<string, unknown>>,
        loading: false,
        initialized: false,
        loadServers: vi.fn(async () => undefined),
    });
});

vi.mock('@/stores/mcp', () => ({
    useMcpStore: () => store,
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

// The card has its own tests; here only its event contract matters.
vi.mock('@/views/SettingsView/components/McpTools/components/McpServerCard.vue', () => ({
    default: {
        name: 'McpServerCard',
        props: ['server', 'selected', 'isToggling'],
        emits: ['toggle-enabled', 'delete', 'context-menu'],
        template: `
                <div>
                    <button
                        :data-testid="'server-' + server.id"
                        :data-selected="selected"
                        :data-toggling="isToggling"
                        @click="$emit('click', server)"
                        @contextmenu="$emit('context-menu', $event)"
                    >
                        {{ server.name }}
                    </button>
                    <button
                        :data-testid="'toggle-' + server.id"
                        @click.stop="$emit('toggle-enabled', server.id)"
                    />
                    <button
                        :data-testid="'delete-' + server.id"
                        @click.stop="$emit('delete')"
                    />
                </div>
            `,
    },
}));

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
    return mount(McpServerList, {
        props: { selectedServer: null, togglingServers: new Set<number>(), ...props },
    });
}

function selectCalls(wrapper: ReturnType<typeof mountList>) {
    return (wrapper.emitted('select') ?? []).map((call) => call[0]);
}

/** The most recent selection the list asked the parent to make. */
function lastSelect(wrapper: ReturnType<typeof mountList>) {
    const calls = selectCalls(wrapper);
    return calls[calls.length - 1];
}

beforeEach(() => {
    setLocale('zh-CN');
    store.servers = [];
    store.loading = false;
    store.initialized = false;
    store.loadServers = vi.fn(async () => undefined);
});

describe('user opens the server list', () => {
    it('user gets the first server selected when none was chosen yet', async () => {
        store.servers = [makeServer(1), makeServer(2)];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();

        expect(selectCalls(wrapper)[0]).toMatchObject({ id: 1 });
    });

    it('user gets no automatic selection when the list is empty', async () => {
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();

        expect(selectCalls(wrapper)).toHaveLength(0);
    });

    it('user keeps their own selection instead of jumping to the first server', async () => {
        store.servers = [makeServer(1), makeServer(2)];
        store.initialized = true;

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();

        expect(selectCalls(wrapper)).toHaveLength(0);
    });

    it('user gets the servers loaded when the panel is the first thing opened', async () => {
        store.servers = [makeServer(1)];

        const wrapper = mountList();
        await flushPromises();

        expect(store.loadServers).toHaveBeenCalledOnce();
        expect(selectCalls(wrapper)[0]).toMatchObject({ id: 1 });
    });

    it('user sees a placeholder row for every server still loading', () => {
        store.loading = true;
        store.initialized = true;

        const wrapper = mountList();

        expect(wrapper.findAll('.animate-pulse')).toHaveLength(3);
        expect(wrapper.findAll('[data-testid^="server-"]')).toHaveLength(0);
    });

    it('user sees every saved server named in the list', async () => {
        store.servers = [makeServer(1, 'filesystem'), makeServer(2, 'github')];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();

        expect(wrapper.get('[data-testid="server-1"]').text()).toBe('filesystem');
        expect(wrapper.get('[data-testid="server-2"]').text()).toBe('github');
    });

    it('user sees which server is currently open', async () => {
        store.servers = [makeServer(1), makeServer(2)];
        store.initialized = true;

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();

        expect(wrapper.get('[data-testid="server-1"]').attributes('data-selected')).toBe('false');
        expect(wrapper.get('[data-testid="server-2"]').attributes('data-selected')).toBe('true');
    });

    it('user sees a server being switched shown as busy', async () => {
        store.servers = [makeServer(1)];
        store.initialized = true;

        const wrapper = mountList({ togglingServers: new Set([1]) });
        await flushPromises();

        expect(wrapper.get('[data-testid="server-1"]').attributes('data-toggling')).toBe('true');
    });

    it('user gets the picked server forwarded when they click a card', async () => {
        store.servers = [makeServer(1), makeServer(2)];
        store.initialized = true;

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();
        await wrapper.get('[data-testid="server-1"]').trigger('click');

        expect(lastSelect(wrapper)).toMatchObject({ id: 1 });
    });

    it('user gets the enable switch forwarded with the server it belongs to', async () => {
        store.servers = [makeServer(3)];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();
        await wrapper.get('[data-testid="toggle-3"]').trigger('click');

        expect(wrapper.emitted('toggle-enabled')?.[0]).toEqual([3]);
    });

    it('user gets the delete request forwarded with the server it belongs to', async () => {
        store.servers = [makeServer(4)];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();
        await wrapper.get('[data-testid="delete-4"]').trigger('click');

        expect(wrapper.emitted('delete')?.[0]).toEqual([4]);
    });

    it('user gets the right-click forwarded so a context menu can open', async () => {
        store.servers = [makeServer(5)];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();
        await wrapper.get('[data-testid="server-5"]').trigger('contextmenu');

        expect(wrapper.emitted('context-menu')?.[0]?.[0]).toBe(5);
    });

    it('user gets the unsaved row dropped when they click an existing server', async () => {
        store.servers = [makeServer(1), makeServer(2)];
        store.initialized = true;

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        await flushPromises();
        expect(wrapper.text()).toContain('新建服务器');

        await wrapper.get('[data-testid="server-1"]').trigger('click');
        await flushPromises();

        expect(wrapper.text()).not.toContain('新建服务器');
        expect(lastSelect(wrapper)).toMatchObject({ id: 1 });
    });
});

describe('user adds a server from the list', () => {
    it('user sees a placeholder row while the new server is unsaved', async () => {
        store.servers = [];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        await flushPromises();

        expect(wrapper.text()).toContain('新建服务器');
        expect(wrapper.text()).toContain('请在右侧填写服务器配置');
    });

    it('user gets the unsaved server handed to the form straight away', async () => {
        store.servers = [];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        await flushPromises();

        expect(selectCalls(wrapper)[0]).toMatchObject({ id: -1, transport_type: 'stdio' });
    });

    it('user gets the first server back when they cancel the new one', async () => {
        store.servers = [makeServer(1), makeServer(2)];
        store.initialized = true;

        const wrapper = mountList({ selectedServer: makeServer(2) });
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        (wrapper.vm as unknown as { handleServerCancelled: () => void }).handleServerCancelled();
        await flushPromises();

        expect(lastSelect(wrapper)).toMatchObject({ id: 1 });
    });

    it('user gets an empty selection back when they cancel with no servers saved', async () => {
        store.servers = [];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        (wrapper.vm as unknown as { handleServerCancelled: () => void }).handleServerCancelled();
        await flushPromises();

        expect(lastSelect(wrapper)).toBeNull();
    });

    it('user gets the newest server opened after saving one', async () => {
        store.servers = [makeServer(1)];
        store.initialized = true;

        const wrapper = mountList({ selectedServer: makeServer(1) });
        await flushPromises();

        store.servers = [makeServer(1), makeServer(2, 'just-saved')];
        await (
            wrapper.vm as unknown as { handleServerSaved: () => Promise<void> }
        ).handleServerSaved();
        await flushPromises();

        expect(store.loadServers).toHaveBeenCalledTimes(1);
        expect(lastSelect(wrapper)).toMatchObject({ name: 'just-saved' });
    });

    it('user gets no selection when saving the very first server fails to return a list', async () => {
        store.servers = [];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();
        await (
            wrapper.vm as unknown as { handleServerSaved: () => Promise<void> }
        ).handleServerSaved();
        await flushPromises();

        expect(selectCalls(wrapper)).toHaveLength(0);
    });

    it('user gets the unsaved row cleared once the new server is saved', async () => {
        store.servers = [];
        store.initialized = true;

        const wrapper = mountList();
        await flushPromises();
        (wrapper.vm as unknown as { addNewServer: () => void }).addNewServer();
        await flushPromises();
        store.servers = [makeServer(3)];
        await (
            wrapper.vm as unknown as { handleServerSaved: () => Promise<void> }
        ).handleServerSaved();
        await flushPromises();

        expect(wrapper.text()).not.toContain('新建服务器');
    });
});
