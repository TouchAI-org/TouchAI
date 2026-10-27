import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/types/session';

const { loadSessionHistoryPageMock } = vi.hoisted(() => ({
    loadSessionHistoryPageMock: vi.fn(),
}));

vi.mock('@/services/AgentService/session', () => ({
    loadSessionHistoryPage: loadSessionHistoryPageMock,
}));

vi.mock('@/services/AgentService', () => ({
    sessionTaskCenter: {
        subscribeTask: vi.fn(),
        cancelTask: vi.fn(),
        attachSessionView: vi.fn(),
    },
}));

import { useAgentState } from '@/composables/agent/useAgentState';

function message(id: string): SessionMessage {
    return { id, role: 'assistant', content: id, parts: [], timestamp: 1 };
}

describe('history paging state', () => {
    beforeEach(() => {
        loadSessionHistoryPageMock.mockReset();
    });

    it('starts with no older pages and records the first-page cursor', async () => {
        const mounted = await mountComposable(() => useAgentState({}));

        expect(mounted.result.hasOlderHistory.value).toBe(false);
        expect(mounted.result.oldestLoadedMessageId.value).toBeNull();
        expect(mounted.result.isLoadingOlderHistory.value).toBe(false);

        mounted.result.applyFirstHistoryPage({ hasMore: true, oldestMessageId: 10 });
        expect(mounted.result.hasOlderHistory.value).toBe(true);
        expect(mounted.result.oldestLoadedMessageId.value).toBe(10);

        mounted.unmount();
    });

    it('prepends older messages and skips ids that are already shown', async () => {
        const mounted = await mountComposable(() => useAgentState({}));
        mounted.result.sessionHistory.value = [message('m10'), message('m11')];

        mounted.result.prependHistory([message('m8'), message('m9'), message('m10')]);

        expect(mounted.result.sessionHistory.value.map((item) => item.id)).toEqual([
            'm8',
            'm9',
            'm10',
            'm11',
        ]);
        // 没有新增时不改变数组引用，避免触发无意义的重新渲染。
        const before = mounted.result.sessionHistory.value;
        mounted.result.prependHistory([message('m10')]);
        expect(mounted.result.sessionHistory.value).toBe(before);

        mounted.unmount();
    });

    it('keeps the previous cursor when a page reports none and resets on clear', async () => {
        const mounted = await mountComposable(() => useAgentState({}));
        mounted.result.applyFirstHistoryPage({ hasMore: true, oldestMessageId: 10 });

        mounted.result.applyOlderHistoryPage({ hasMore: false, oldestMessageId: null });
        expect(mounted.result.hasOlderHistory.value).toBe(false);
        expect(mounted.result.oldestLoadedMessageId.value).toBe(10);

        mounted.result.resetHistoryPaging();
        expect(mounted.result.oldestLoadedMessageId.value).toBeNull();

        mounted.unmount();
    });
});
