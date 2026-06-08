import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MemorySection from '@/views/SettingsView/components/Memory/index.vue';

const contextMenuState = vi.hoisted(() => ({
    lastContext: null as number | null,
    open: vi.fn(),
    onSelect: null as ((key: string, context: number) => void) | null,
}));

const alertState = vi.hoisted(() => ({
    error: vi.fn(),
    success: vi.fn(),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

vi.mock('@composables/useContextMenu.ts', () => ({
    useContextMenu: (_items: unknown, onSelect: (key: string, context: number) => void) => {
        contextMenuState.onSelect = onSelect;
        return {
            open: (event: MouseEvent, context?: number) => {
                contextMenuState.lastContext = context ?? null;
                contextMenuState.open(event, context);
            },
            close: vi.fn(),
        };
    },
}));

vi.mock('@/database/queries/memoryItems', () => ({
    createMemoryItem: vi.fn(),
    disableMemoryItem: vi.fn(),
    findMemoryDirectoryItems: vi.fn(),
    readMemoryItemsByIds: vi.fn(),
    updateMemoryItem: vi.fn(),
}));

const memoryQueries = await import('@/database/queries/memoryItems');

const AlertMessageStub = {
    name: 'AlertMessageStub',
    template: '<div />',
    setup(
        _props: unknown,
        { expose }: { expose: (exposed: Record<string, unknown>) => void }
    ) {
        expose(alertState);
    },
};

const enabledMemory = {
    id: 11,
    title: '桌面工作方式',
    applicability: '当任务依赖当前桌面状态时读取。',
    content: '先观察托盘、窗口和当前线程的上下文。',
    enabled: 1,
    source_session_id: null,
    source_message_id: null,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    last_used_at: null,
};

const secondMemory = {
    ...enabledMemory,
    id: 12,
    title: '常用测试环境',
    applicability: '当需要在本机运行桌面端验证时读取。',
    content: '优先在 G 盘运行大体积验证。',
    updated_at: '2026-06-02T00:00:00.000Z',
};

const disabledMemory = {
    ...enabledMemory,
    id: 13,
    title: '已禁用记忆',
    applicability: '当需要恢复旧偏好时读取。',
    content: '这是一个已禁用的历史偏好。',
    enabled: 0,
    updated_at: '2026-06-04T00:00:00.000Z',
};

function toDirectoryItem(memory: typeof enabledMemory) {
    return {
        id: memory.id,
        title: memory.title,
        applicability: memory.applicability,
        enabled: memory.enabled,
        updated_at: memory.updated_at,
    };
}

function mountMemorySection() {
    return mount(MemorySection, {
        global: {
            stubs: {
                AlertMessage: AlertMessageStub,
            },
        },
    });
}

async function settle() {
    await flushPromises();
    await Promise.resolve();
}

async function runAutosaveDelay() {
    await vi.advanceTimersByTimeAsync(900);
    await settle();
}

function triggerDeleteFromContextMenu(context = contextMenuState.lastContext) {
    if (context === null || !contextMenuState.onSelect) {
        throw new Error('No memory context menu selection is available.');
    }

    contextMenuState.onSelect('delete', context);
}

describe('SettingsMemorySection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetAllMocks();
        contextMenuState.lastContext = null;
        contextMenuState.onSelect = null;
        vi.mocked(memoryQueries.findMemoryDirectoryItems).mockResolvedValue([
            toDirectoryItem(secondMemory),
            toDirectoryItem(enabledMemory),
            toDirectoryItem(disabledMemory),
        ]);
        vi.mocked(memoryQueries.readMemoryItemsByIds).mockImplementation(async (ids: number[]) =>
            [enabledMemory, secondMemory, disabledMemory].filter((memory) => ids.includes(memory.id))
        );
        vi.mocked(memoryQueries.createMemoryItem).mockResolvedValue({
            ...enabledMemory,
            id: 21,
            title: '新的桌面偏好',
            applicability: '当任务涉及桌面通知时读取。',
            content: '测试前先确认通知权限和托盘状态。',
        });
        vi.mocked(memoryQueries.updateMemoryItem).mockImplementation(async (id, patch) => {
            const source = [enabledMemory, secondMemory, disabledMemory].find(
                (memory) => memory.id === id
            );
            return source
                ? {
                      ...source,
                      ...patch,
                      updated_at: '2026-06-03T00:00:00.000Z',
                  }
                : undefined;
        });
        vi.mocked(memoryQueries.disableMemoryItem).mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows a full-width empty state when there are no memories', async () => {
        vi.mocked(memoryQueries.findMemoryDirectoryItems).mockResolvedValue([]);

        const wrapper = mountMemorySection();
        await settle();

        expect(wrapper.find('[data-testid="settings-memory-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-memory-empty-workspace"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('暂无记忆');
        expect(wrapper.text()).toContain('新增记忆');
        expect(wrapper.text()).not.toContain('长期记忆');
    });

    it('opens a draft editor without adding a blank item to the sidebar and discards it when switching selection', async () => {
        const wrapper = mountMemorySection();
        await settle();

        expect(wrapper.findAll('[data-testid^="settings-memory-item-"]')).toHaveLength(3);

        await wrapper.get('[data-testid="settings-memory-add-button"]').trigger('click');
        await settle();

        expect(wrapper.findAll('[data-testid^="settings-memory-item-"]')).toHaveLength(3);
        expect(wrapper.get('[data-testid="settings-memory-title-input"]').attributes('placeholder')).toBe(
            '给这条记忆起个标题'
        );
        expect(
            wrapper.get('[data-testid="settings-memory-applicability-input"]').attributes(
                'placeholder'
            )
        ).toBe('说明它在什么情况下适用');
        expect(wrapper.get('[data-testid="settings-memory-content-input"]').attributes('placeholder')).toBe(
            '写下希望 TouchAI 记住的内容'
        );
        expect(wrapper.find('[data-testid="settings-memory-save"]').exists()).toBe(false);

        await wrapper.get('[data-testid="settings-memory-item-12"]').trigger('click');
        await settle();

        expect(memoryQueries.createMemoryItem).not.toHaveBeenCalled();
        expect(
            (wrapper.get('[data-testid="settings-memory-title-input"]').element as HTMLInputElement)
                .value
        ).toBe(secondMemory.title);
    });

    it('autosaves a new memory only after all required fields are filled', async () => {
        vi.mocked(memoryQueries.findMemoryDirectoryItems)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    id: 21,
                    title: '新的桌面偏好',
                    applicability: '当任务涉及桌面通知时读取。',
                    enabled: 1,
                    updated_at: '2026-06-03T00:00:00.000Z',
                },
            ]);
        vi.mocked(memoryQueries.readMemoryItemsByIds).mockResolvedValue([
            {
                ...enabledMemory,
                id: 21,
                title: '新的桌面偏好',
                applicability: '当任务涉及桌面通知时读取。',
                content: '测试前先确认通知权限和托盘状态。',
            },
        ]);

        const wrapper = mountMemorySection();
        await settle();

        await wrapper.get('[data-testid="settings-memory-add-button"]').trigger('click');
        await settle();

        await wrapper.get('[data-testid="settings-memory-title-input"]').setValue('新的桌面偏好');
        await runAutosaveDelay();
        expect(memoryQueries.createMemoryItem).not.toHaveBeenCalled();

        await wrapper
            .get('[data-testid="settings-memory-applicability-input"]')
            .setValue('当任务涉及桌面通知时读取。');
        await wrapper
            .get('[data-testid="settings-memory-content-input"]')
            .setValue('测试前先确认通知权限和托盘状态。');
        await runAutosaveDelay();

        expect(memoryQueries.createMemoryItem).toHaveBeenCalledWith({
            title: '新的桌面偏好',
            applicability: '当任务涉及桌面通知时读取。',
            content: '测试前先确认通知权限和托盘状态。',
            enabled: 1,
        });
        expect(wrapper.find('[data-testid="settings-memory-panel"]').exists()).toBe(true);
        expect(
            (wrapper.get('[data-testid="settings-memory-title-input"]').element as HTMLInputElement)
                .value
        ).toBe('新的桌面偏好');
    });

    it('autosaves edits for an existing memory and does not raise validation alerts for incomplete input', async () => {
        const wrapper = mountMemorySection();
        await settle();

        await wrapper.get('[data-testid="settings-memory-title-input"]').setValue('');
        await runAutosaveDelay();

        expect(memoryQueries.updateMemoryItem).not.toHaveBeenCalled();
        expect(alertState.error).not.toHaveBeenCalled();

        await wrapper
            .get('[data-testid="settings-memory-title-input"]')
            .setValue('更新后的桌面工作方式');
        await wrapper
            .get('[data-testid="settings-memory-applicability-input"]')
            .setValue('当任务需要判断桌面可见状态时读取。');
        await wrapper
            .get('[data-testid="settings-memory-content-input"]')
            .setValue('先确认窗口焦点、托盘图标和正在运行的验证流程。');
        await runAutosaveDelay();

        expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(12, {
            title: '更新后的桌面工作方式',
            applicability: '当任务需要判断桌面可见状态时读取。',
            content: '先确认窗口焦点、托盘图标和正在运行的验证流程。',
        });
    });

    it('opens a context menu for persisted memories and removes the item after delete without reporting a false failure', async () => {
        const wrapper = mountMemorySection();
        await settle();

        await wrapper.get('[data-testid="settings-memory-item-12"]').trigger('contextmenu');

        expect(contextMenuState.open).toHaveBeenCalledTimes(1);
        expect(contextMenuState.lastContext).toBe(12);

        triggerDeleteFromContextMenu();
        await settle();

        expect(memoryQueries.disableMemoryItem).toHaveBeenCalledWith(12);
        expect(wrapper.find('[data-testid="settings-memory-item-12"]').exists()).toBe(true);
        expect(wrapper.get('[data-testid="settings-memory-toggle-12"]').attributes('aria-pressed')).toBe(
            'false'
        );
        expect(alertState.error).not.toHaveBeenCalled();
    });

    it('applies short character limits to title and applicability inputs', async () => {
        const wrapper = mountMemorySection();
        await settle();

        expect(wrapper.get('[data-testid="settings-memory-title-input"]').attributes('maxlength')).toBe(
            '24'
        );
        expect(
            wrapper.get('[data-testid="settings-memory-applicability-input"]').attributes(
                'maxlength'
            )
        ).toBe('48');
    });

    it('shows disabled memories in the sidebar and allows re-enabling them', async () => {
        const wrapper = mountMemorySection();
        await settle();

        expect(wrapper.get('[data-testid="settings-memory-item-13"]').text()).toContain('已禁用记忆');

        await wrapper.get('[data-testid="settings-memory-toggle-13"]').trigger('click');
        await settle();

        expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(13, { enabled: 1 });
    });

    it('shows an explicit load error state and can retry loading', async () => {
        vi.mocked(memoryQueries.findMemoryDirectoryItems)
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce([toDirectoryItem(secondMemory), toDirectoryItem(enabledMemory)]);

        const wrapper = mountMemorySection();
        await settle();

        expect(wrapper.find('[data-testid="settings-memory-load-error"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-memory-empty-workspace"]').exists()).toBe(false);

        await wrapper.get('[data-testid="settings-memory-retry-button"]').trigger('click');
        await settle();

        expect(wrapper.find('[data-testid="settings-memory-load-error"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-memory-item-12"]').exists()).toBe(true);
    });
});
