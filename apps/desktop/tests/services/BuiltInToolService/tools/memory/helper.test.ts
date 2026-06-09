import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildMemoryApprovalRequest,
    executeMemoryTool,
    formatMemoryToolResult,
    parseMemoryRequest,
} from '@/services/BuiltInToolService/tools/memory/helper';

vi.mock('@/database/queries/memoryItems', () => ({
    createMemoryItem: vi.fn(),
    disableMemoryItem: vi.fn(),
    findMemoryItemByNormalizedTitle: vi.fn(),
    readEnabledMemoryItemsByIds: vi.fn(),
    touchMemoryItemsLastUsed: vi.fn(),
    updateMemoryItem: vi.fn(),
}));

const memoryQueries = await import('@/database/queries/memoryItems');

const memoryRow = {
    id: 3,
    title: '桌面 Agent 工作方式',
    applicability: '当任务涉及桌面文件、截图、剪贴板或跨会话连续工作时读取。',
    content: '优先使用工具观察真实桌面上下文，不要编造文件、截图或系统状态。',
    enabled: 1,
    source_session_id: null,
    source_message_id: null,
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    last_used_at: null,
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(memoryQueries.createMemoryItem).mockResolvedValue(memoryRow);
    vi.mocked(memoryQueries.disableMemoryItem).mockResolvedValue({ ...memoryRow, enabled: 0 });
    vi.mocked(memoryQueries.findMemoryItemByNormalizedTitle).mockResolvedValue(undefined);
    vi.mocked(memoryQueries.readEnabledMemoryItemsByIds).mockResolvedValue([memoryRow]);
    vi.mocked(memoryQueries.touchMemoryItemsLastUsed).mockResolvedValue();
    vi.mocked(memoryQueries.updateMemoryItem).mockResolvedValue(memoryRow);
});

describe('memory tool helper', () => {
    it('parses read requests with deduplicated ids', () => {
        expect(parseMemoryRequest({ action: 'read', ids: [3, 3, '4'] })).toEqual({
            action: 'read',
            ids: [3, 4],
        });
    });

    it('requires title, applicability, and content for upsert', () => {
        expect(() => parseMemoryRequest({ action: 'upsert', title: 'Only title' })).toThrow(
            /applicability/
        );
    });

    it('rejects secret-like memory content', async () => {
        await expect(
            executeMemoryTool({
                action: 'upsert',
                title: 'API key',
                applicability: 'When calling services.',
                content: 'OPENAI_API_KEY=sk-test-secret',
            })
        ).resolves.toMatchObject({
            isError: true,
            status: 'error',
        });
    });

    it('builds approval requests only for writes', () => {
        expect(buildMemoryApprovalRequest({ action: 'read', ids: [3] })).toBeNull();

        const approval = buildMemoryApprovalRequest({
            action: 'upsert',
            title: '桌面 Agent 工作方式',
            applicability: memoryRow.applicability,
            content: memoryRow.content,
        });

        expect(approval?.title).toMatch(/记忆修改确认|memoryChangeTitle/);
        expect(approval?.command).toContain('upsert');
        expect(approval?.description?.trim().length).toBeGreaterThan(0);
    });

    it('reads memory rows and touches last_used_at', async () => {
        const result = await executeMemoryTool({ action: 'read', ids: [3] });

        expect(result.isError).toBe(false);
        expect(result.result).toContain('memory_id: 3');
        expect(memoryQueries.touchMemoryItemsLastUsed).toHaveBeenCalledWith([3]);
    });

    it('updates a memory by explicit id when provided', async () => {
        const result = await executeMemoryTool({
            action: 'upsert',
            id: 3,
            title: '桌面 Agent 工作方式',
            applicability: memoryRow.applicability,
            content: '通过 id 更新。',
        });

        expect(result.isError).toBe(false);
        expect(memoryQueries.readEnabledMemoryItemsByIds).toHaveBeenCalledWith([3]);
        expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(3, {
            title: '桌面 Agent 工作方式',
            applicability: memoryRow.applicability,
            content: '通过 id 更新。',
            enabled: 1,
        });
    });

    it('disables memory items', async () => {
        const result = await executeMemoryTool({ action: 'delete', id: 3 });

        expect(result).toMatchObject({
            isError: false,
            status: 'success',
        });
        expect(memoryQueries.disableMemoryItem).toHaveBeenCalledWith(3);
    });

    it('formats empty read results clearly', () => {
        expect(formatMemoryToolResult('read', [])).toBe('No enabled memories found.');
    });
});
