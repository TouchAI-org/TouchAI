import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MemorySection from '@/views/SettingsView/components/Memory/index.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@/database/queries/memoryItems', () => ({
    createMemoryItem: vi.fn(),
    findMemoryDirectoryItems: vi.fn(),
    readMemoryItemsByIds: vi.fn(),
    updateMemoryItem: vi.fn(),
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

const memoryQueries = await import('@/database/queries/memoryItems');

const enabledMemory = {
    id: 3,
    title: '桌面 Agent 工作方式',
    applicability: '当任务涉及桌面状态时读取。',
    content: '优先观察真实桌面上下文。',
    enabled: 1,
    source_session_id: null,
    source_message_id: null,
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    last_used_at: null,
};

const disabledMemory = {
    ...enabledMemory,
    id: 4,
    title: '窗口摆放偏好',
    enabled: 0,
};

const AlertMessageStub = {
    template: '<div />',
    setup(_props: unknown, { expose }: { expose: (exposed: Record<string, unknown>) => void }) {
        expose({
            success: vi.fn(),
            error: vi.fn(),
        });
    },
};

function createGlobalStubs() {
    return {
        stubs: {
            AlertMessage: AlertMessageStub,
            AppIcon: true,
        },
    };
}

function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

describe('Settings Memory section', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(memoryQueries.findMemoryDirectoryItems).mockResolvedValue([
            enabledMemory,
            disabledMemory,
        ]);
        vi.mocked(memoryQueries.createMemoryItem).mockResolvedValue(enabledMemory);
        vi.mocked(memoryQueries.readMemoryItemsByIds).mockImplementation(async (ids: number[]) =>
            [enabledMemory, disabledMemory].filter((item) => ids.includes(item.id))
        );
        vi.mocked(memoryQueries.updateMemoryItem).mockResolvedValue({
            ...enabledMemory,
            enabled: 0,
        });
    });

    it('uses memory settings layout, matching panel background, and toggles enabled state', async () => {
        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        expect(wrapper.text()).not.toContain('长期记忆');
        expect(wrapper.get('[data-testid="settings-memory-panel"]').attributes()).toHaveProperty(
            'data-settings-secondary-panel',
            'true'
        );
        expect(
            wrapper.get('[data-testid="settings-memory-panel-resizer"]').attributes()
        ).toMatchObject({
            role: 'separator',
            tabindex: '0',
        });
        expect(wrapper.get('[data-testid="settings-memory-content"]').classes()).toContain(
            'bg-white'
        );
        expect(wrapper.text()).toContain('窗口摆放偏好');
        expect(wrapper.text()).toContain('新增记忆');

        await wrapper.get('[data-testid="settings-memory-toggle-3"]').trigger('click');
        await flushPromises();

        expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(3, { enabled: 0 });
    });

    it('saves edited title, applicability, and content', async () => {
        const updatedMemory = {
            ...enabledMemory,
            title: '更新后的标题',
            applicability: '更新后的适用条件。',
            content: '更新后的记忆内容。',
        };
        vi.mocked(memoryQueries.updateMemoryItem).mockResolvedValue(updatedMemory);

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        const titleInput = wrapper.get('input');
        const textareas = wrapper.findAll('textarea');
        await titleInput.setValue(updatedMemory.title);
        await textareas[0]!.setValue(updatedMemory.applicability);
        await textareas[1]!.setValue(updatedMemory.content);
        await wrapper.get('[data-testid="settings-memory-save"]').trigger('click');
        await flushPromises();

        expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(3, {
            title: updatedMemory.title,
            applicability: updatedMemory.applicability,
            content: updatedMemory.content,
        });
    });

    it('does not write enabled state when saving edited memory text', async () => {
        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        await wrapper.get('input').setValue('只保存文本的标题');
        const textareas = wrapper.findAll('textarea');
        await textareas[0]!.setValue('只保存文本的适用条件。');
        await textareas[1]!.setValue('只保存文本的内容。');
        await wrapper.get('[data-testid="settings-memory-save"]').trigger('click');
        await flushPromises();

        const savePatch = vi.mocked(memoryQueries.updateMemoryItem).mock.calls[0]?.[1];
        expect(savePatch).not.toHaveProperty('enabled');
    });

    it('does not save invalid memory edits', async () => {
        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        await wrapper.get('input').setValue('');
        await wrapper.get('[data-testid="settings-memory-save"]').trigger('click');
        await flushPromises();

        expect(memoryQueries.updateMemoryItem).not.toHaveBeenCalled();
    });

    it('recovers when saving edited memory fails', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        vi.mocked(memoryQueries.updateMemoryItem).mockRejectedValue(new Error('save failed'));

        try {
            const wrapper = mount(MemorySection, {
                global: createGlobalStubs(),
            });
            await flushPromises();

            await wrapper.get('input').setValue('保存失败后的标题');
            await wrapper.get('[data-testid="settings-memory-save"]').trigger('click');
            await flushPromises();

            expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(3, {
                title: '保存失败后的标题',
                applicability: enabledMemory.applicability,
                content: enabledMemory.content,
            });
            expect(wrapper.get('[data-testid="settings-memory-save"]').attributes('disabled')).toBe(
                undefined
            );
        } finally {
            consoleError.mockRestore();
        }
    });

    it('preserves unsaved edits when toggling the selected memory', async () => {
        const draft = {
            title: '未保存的标题草稿',
            applicability: '未保存的适用条件草稿。',
            content: '未保存的记忆内容草稿。',
        };

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        const titleInput = wrapper.get('input');
        const textareas = wrapper.findAll('textarea');
        await titleInput.setValue(draft.title);
        await textareas[0]!.setValue(draft.applicability);
        await textareas[1]!.setValue(draft.content);

        await wrapper.get('[data-testid="settings-memory-toggle-3"]').trigger('click');
        await flushPromises();

        expect((wrapper.get('input').element as HTMLInputElement).value).toBe(draft.title);
        expect((wrapper.findAll('textarea')[0]!.element as HTMLTextAreaElement).value).toBe(
            draft.applicability
        );
        expect((wrapper.findAll('textarea')[1]!.element as HTMLTextAreaElement).value).toBe(
            draft.content
        );
        expect(wrapper.text()).toContain('已禁用');
    });

    it('preserves toggled enabled state when saving edited memory', async () => {
        const draft = {
            title: '切换后保存的标题',
            applicability: '切换后保存的适用条件。',
            content: '切换后保存的记忆内容。',
        };
        vi.mocked(memoryQueries.updateMemoryItem).mockImplementation(async (_id, patch) => ({
            ...enabledMemory,
            ...patch,
            updated_at: '2026-05-22T01:00:00.000Z',
        }));

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        await wrapper.get('[data-testid="settings-memory-toggle-3"]').trigger('click');
        await flushPromises();

        await wrapper.get('input').setValue(draft.title);
        const textareas = wrapper.findAll('textarea');
        await textareas[0]!.setValue(draft.applicability);
        await textareas[1]!.setValue(draft.content);
        await wrapper.get('[data-testid="settings-memory-save"]').trigger('click');
        await flushPromises();

        expect(memoryQueries.updateMemoryItem).toHaveBeenLastCalledWith(3, {
            title: draft.title,
            applicability: draft.applicability,
            content: draft.content,
        });
    });

    it('preserves pending toggled enabled state when saving before toggle finishes', async () => {
        const toggleUpdate = createDeferred<typeof enabledMemory>();
        const draft = {
            title: '未等开关完成的标题',
            applicability: '未等开关完成的适用条件。',
            content: '未等开关完成的记忆内容。',
        };
        vi.mocked(memoryQueries.updateMemoryItem).mockImplementation(async (_id, patch) => {
            if ('enabled' in patch && !('title' in patch)) {
                return toggleUpdate.promise;
            }

            return {
                ...enabledMemory,
                ...patch,
                updated_at: '2026-05-22T01:00:00.000Z',
            };
        });

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        await wrapper.get('[data-testid="settings-memory-toggle-3"]').trigger('click');

        await wrapper.get('input').setValue(draft.title);
        const textareas = wrapper.findAll('textarea');
        await textareas[0]!.setValue(draft.applicability);
        await textareas[1]!.setValue(draft.content);
        await wrapper.get('[data-testid="settings-memory-save"]').trigger('click');
        await flushPromises();

        try {
            expect(memoryQueries.updateMemoryItem).toHaveBeenLastCalledWith(3, {
                title: draft.title,
                applicability: draft.applicability,
                content: draft.content,
            });
        } finally {
            toggleUpdate.resolve({
                ...enabledMemory,
                enabled: 0,
                updated_at: '2026-05-22T01:00:00.000Z',
            });
            await flushPromises();
        }
    });

    it('keeps pending toggle visible when a save finishes before the toggle request', async () => {
        const saveUpdate = createDeferred<typeof enabledMemory>();
        const toggleUpdate = createDeferred<typeof enabledMemory>();
        vi.mocked(memoryQueries.updateMemoryItem).mockImplementation(async (_id, patch) => {
            if ('enabled' in patch) {
                return toggleUpdate.promise;
            }

            return saveUpdate.promise;
        });

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        await wrapper.get('input').setValue('保存中的标题');
        await wrapper.get('[data-testid="settings-memory-save"]').trigger('click');
        await wrapper.get('[data-testid="settings-memory-toggle-3"]').trigger('click');

        expect(wrapper.text()).toContain('已禁用');

        saveUpdate.resolve({
            ...enabledMemory,
            title: '保存中的标题',
            enabled: 1,
            updated_at: '2026-05-22T01:00:00.000Z',
        });
        await flushPromises();

        try {
            expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(3, { enabled: 0 });
            expect(wrapper.text()).toContain('已禁用');
        } finally {
            toggleUpdate.resolve({
                ...enabledMemory,
                enabled: 0,
                updated_at: '2026-05-22T02:00:00.000Z',
            });
            await flushPromises();
        }
    });

    it('keeps disabled memories visible and can enable them again', async () => {
        vi.mocked(memoryQueries.updateMemoryItem).mockResolvedValue({
            ...disabledMemory,
            enabled: 1,
        });

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        await wrapper.get('[data-testid="settings-memory-item-4"]').trigger('click');
        await wrapper.get('[data-testid="settings-memory-toggle-4"]').trigger('click');
        await flushPromises();

        expect(wrapper.text()).toContain('窗口摆放偏好');
        expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(4, { enabled: 1 });
    });

    it('does not flip the visible enabled state when toggle update returns no row', async () => {
        vi.mocked(memoryQueries.updateMemoryItem).mockResolvedValue(undefined);

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        await wrapper.get('[data-testid="settings-memory-item-4"]').trigger('click');
        await flushPromises();
        expect(wrapper.text()).toContain('已禁用');

        await wrapper.get('[data-testid="settings-memory-toggle-4"]').trigger('click');
        await flushPromises();

        expect(memoryQueries.updateMemoryItem).toHaveBeenCalledWith(4, { enabled: 1 });
        expect(wrapper.text()).toContain('已禁用');
    });

    it('shows a full-width empty memory state and allows manual creation', async () => {
        vi.mocked(memoryQueries.findMemoryDirectoryItems).mockResolvedValue([]);
        const createdMemory = {
            ...enabledMemory,
            title: '新记忆',
            applicability: '在此填写这条记忆在什么情况下适用。',
            content: '在此填写需要保存的可复用上下文。',
            enabled: 0,
        };
        vi.mocked(memoryQueries.createMemoryItem).mockResolvedValue(createdMemory);
        vi.mocked(memoryQueries.findMemoryDirectoryItems)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([createdMemory]);
        vi.mocked(memoryQueries.readMemoryItemsByIds).mockImplementation(async (ids: number[]) =>
            [createdMemory].filter((item) => ids.includes(item.id))
        );

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-memory-panel"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-memory-panel-resizer"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-memory-empty-workspace"]').exists()).toBe(true);
        expect(wrapper.text()).toContain('暂无记忆');
        expect(wrapper.text()).toContain('新增记忆');
        expect(wrapper.text()).not.toContain('长期记忆');
        expect(wrapper.text()).not.toContain('后续由 Agent');

        await wrapper.get('[data-testid="settings-memory-create"]').trigger('click');
        await flushPromises();

        expect(memoryQueries.createMemoryItem).toHaveBeenCalledWith({
            title: '新记忆',
            applicability: '在此填写这条记忆在什么情况下适用。',
            content: '在此填写需要保存的可复用上下文。',
            enabled: 0,
        });
        expect(wrapper.find('[data-testid="settings-memory-panel"]').exists()).toBe(true);
        expect((wrapper.get('input').element as HTMLInputElement).value).toBe('新记忆');
        expect(wrapper.text()).toContain('已禁用');
    });

    it('keeps the created draft visible when refresh fails after creation', async () => {
        vi.mocked(memoryQueries.findMemoryDirectoryItems)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('refresh failed'));

        const createdMemory = {
            ...enabledMemory,
            title: '新记忆',
            applicability: '在此填写这条记忆在什么情况下适用。',
            content: '在此填写需要保存的可复用上下文。',
            enabled: 0,
        };
        vi.mocked(memoryQueries.createMemoryItem).mockResolvedValue(createdMemory);

        const wrapper = mount(MemorySection, {
            global: createGlobalStubs(),
        });
        await flushPromises();

        await wrapper.get('[data-testid="settings-memory-create"]').trigger('click');
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-memory-empty-workspace"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-memory-panel"]').exists()).toBe(true);
        expect((wrapper.get('input').element as HTMLInputElement).value).toBe('新记忆');
        expect(wrapper.text()).toContain('已禁用');
    });
});
