import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { McpServerEntity } from '@database/types';

import McpServerCard from '@/views/SettingsView/components/McpTools/components/McpServerCard.vue';

/**
 * The card is how the user starts, stops and removes an MCP server. Deleting asks first, and the
 * card has to reflect the live connection state, because a wrong dot sends the user looking for a
 * problem in the wrong place.
 */
const { confirmMock, getServerStatusMock } = vi.hoisted(() => ({
    confirmMock: vi.fn(),
    getServerStatusMock: vi.fn(),
}));

vi.mock('@composables/useConfirm', () => ({
    useConfirm: () => ({ confirm: confirmMock }),
}));

vi.mock('@/stores/mcp', () => ({
    useMcpStore: () => ({ getServerStatus: getServerStatusMock }),
}));

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
    return mount(McpServerCard, {
        props: { server: server(), selected: false, ...props },
        global: {
            stubs: {
                Switch: {
                    props: ['checked'],
                    emits: ['change', 'update:checked'],
                    template:
                        '<button role="switch" :aria-checked="checked" @click="$emit(\'change\', !checked)" />',
                },
            },
        },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
    getServerStatusMock.mockReturnValue('connected');
});

describe('user manages an MCP server from its card', () => {
    it('user sees the server name', () => {
        const wrapper = mountCard();

        expect(wrapper.text()).toContain('filesystem');
        wrapper.unmount();
    });

    it('user toggles the server and its id is reported', async () => {
        const wrapper = mountCard({ server: server({ id: 7 }) });

        await wrapper.find('[role="switch"]').trigger('click');

        expect(wrapper.emitted('toggle-enabled')).toEqual([[7]]);
        wrapper.unmount();
    });

    it('user asks to delete and confirms, then the delete is reported', async () => {
        const wrapper = mountCard();

        await (wrapper.vm as unknown as { handleDelete: () => Promise<void> }).handleDelete();

        expect(confirmMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'danger',
                message: expect.stringContaining('filesystem'),
            })
        );
        expect(wrapper.emitted('delete')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user asks to delete and cancels, then nothing is deleted', async () => {
        confirmMock.mockResolvedValue(false);
        const wrapper = mountCard();

        await (wrapper.vm as unknown as { handleDelete: () => Promise<void> }).handleDelete();

        // A cancelled confirmation must not delete the server.
        expect(wrapper.emitted('delete')).toBeUndefined();
        wrapper.unmount();
    });

    it('user gets the connected state shown in green', () => {
        getServerStatusMock.mockReturnValue('connected');
        const wrapper = mountCard();

        expect(wrapper.find('.bg-green-500').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets the connecting state shown in amber', () => {
        getServerStatusMock.mockReturnValue('connecting');
        const wrapper = mountCard();

        expect(wrapper.find('.bg-yellow-500').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets the error state shown in red', () => {
        getServerStatusMock.mockReturnValue('error');
        const wrapper = mountCard();

        expect(wrapper.find('.bg-red-500').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets an unknown state shown as disconnected', () => {
        getServerStatusMock.mockReturnValue(undefined);
        const wrapper = mountCard();

        // An unknown state must not look like a healthy connection.
        expect(wrapper.find('.bg-gray-400').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets each transport labelled', () => {
        for (const [transport, label] of [
            ['stdio', 'Stdio'],
            ['sse', 'SSE'],
            ['http', 'HTTP'],
        ] as const) {
            const wrapper = mountCard({ server: server({ transport_type: transport }) });
            expect(wrapper.text()).toContain(label);
            wrapper.unmount();
        }
    });

    it('user opens the context menu on the card and the event is reported', async () => {
        const wrapper = mountCard();

        await wrapper.find('button').trigger('contextmenu');

        const events = wrapper.emitted('context-menu');
        expect(events).toHaveLength(1);
        // The browser menu must be suppressed so only the app's menu opens.
        expect((events![0]![0] as MouseEvent).defaultPrevented).toBe(true);
        wrapper.unmount();
    });

    it('user gets the selected card marked so the detail pane matches', () => {
        const selected = mountCard({ selected: true });
        const plain = mountCard({ selected: false });

        expect(selected.classes()).toContain('settings-item-selected');
        expect(plain.classes()).toContain('settings-item-unselected');
        selected.unmount();
        plain.unmount();
    });
});
