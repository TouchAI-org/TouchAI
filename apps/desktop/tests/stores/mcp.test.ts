import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findAllMcpServersMock, findMcpToolsByServerIdMock } = vi.hoisted(() => ({
    findAllMcpServersMock: vi.fn(),
    findMcpToolsByServerIdMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    findAllMcpServers: findAllMcpServersMock,
    findMcpToolsByServerId: findMcpToolsByServerIdMock,
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        setStatusFromEvent: vi.fn(),
        refreshAllServerStatuses: vi.fn(),
    },
}));

vi.mock('@services/EventService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@services/EventService')>()),
    eventService: { on: vi.fn() },
}));

describe('user sees the saved mcp servers', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
    });

    it('user gets an empty list with loading finished when servers cannot be read', async () => {
        findAllMcpServersMock.mockRejectedValue(new Error('database is locked'));
        const { useMcpStore } = await import('@/stores/mcp');
        const store = useMcpStore();

        await expect(store.loadServers()).resolves.toBeUndefined();

        expect(store.servers).toEqual([]);
        expect(store.loading).toBe(false);
    });

    it('user gets no tools for a server whose tools cannot be read', async () => {
        findMcpToolsByServerIdMock.mockRejectedValue(new Error('database is locked'));
        const { useMcpStore } = await import('@/stores/mcp');
        const store = useMcpStore();

        await expect(store.loadServerTools(1)).resolves.toBeUndefined();

        expect(store.getServerTools(1)).toEqual([]);
    });
});
