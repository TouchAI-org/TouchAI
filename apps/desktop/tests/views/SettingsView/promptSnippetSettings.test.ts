import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
    PromptSnippetInsertionMode,
    PromptSnippetSettings as PromptSnippetSettingsValue,
} from '@/app/api/settings/preferences';
import { setLocale } from '@/i18n';
import PromptSnippetSettings from '@/views/SettingsView/components/General/PromptSnippetSettings.vue';

const settingsStoreMock = await vi.hoisted(async () => {
    const { ref } = await import('vue');
    const state: {
        promptSnippetInsertionMode: PromptSnippetInsertionMode;
        promptSnippets: PromptSnippetSettingsValue;
    } = {
        promptSnippetInsertionMode: 'paste_only',
        promptSnippets: {
            schemaVersion: 1,
            items: [
                {
                    id: 'snippet-a',
                    title: 'Summarize',
                    body: 'Summarize the current draft.',
                    isFavorite: true,
                    sortOrder: 1,
                    lastUsedAt: null,
                    createdAt: '2026-11-22T01:00:00.000Z',
                    updatedAt: '2026-11-22T01:00:00.000Z',
                },
            ],
            storageIssue: null,
        },
    };

    return {
        state,
        settings: ref(state),
        updatePromptSnippets: vi.fn().mockResolvedValue(undefined),
        updatePromptSnippetInsertionMode: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('pinia', () => ({
    storeToRefs: (store: typeof settingsStoreMock) => ({
        settings: store.settings,
    }),
}));

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsStoreMock,
}));

function snippet(index = 0) {
    return {
        id: `snippet-${index}`,
        title: `Snippet ${index}`,
        body: `Prompt body ${index}`,
        isFavorite: false,
        sortOrder: index,
        lastUsedAt: null,
        createdAt: '2026-11-22T01:00:00.000Z',
        updatedAt: '2026-11-22T01:00:00.000Z',
    };
}

describe('given the user manages lightweight prompt snippets', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
        settingsStoreMock.settings.value = structuredClone(settingsStoreMock.state);
    });

    it('user adds a pinned plain-text snippet and sees it saved', async () => {
        const wrapper = mount(PromptSnippetSettings);

        await wrapper.get('[data-testid="prompt-snippet-add"]').trigger('click');
        await wrapper.get('[data-testid="prompt-snippet-title"]').setValue('Review');
        await wrapper
            .get('[data-testid="prompt-snippet-body"]')
            .setValue('Review this change carefully.');
        await wrapper.get('[data-testid="prompt-snippet-favorite"]').trigger('click');
        await wrapper.get('[data-testid="prompt-snippet-editor"]').trigger('submit');
        await flushPromises();

        expect(settingsStoreMock.updatePromptSnippets).toHaveBeenCalledWith(
            expect.objectContaining({
                schemaVersion: 1,
                items: expect.arrayContaining([
                    expect.objectContaining({
                        title: 'Review',
                        body: 'Review this change carefully.',
                        isFavorite: true,
                    }),
                ]),
            })
        );
    });

    it('user enters an over-limit body and sees an error without it being truncated', async () => {
        const wrapper = mount(PromptSnippetSettings);
        const body = 'x'.repeat(10_001);

        await wrapper.get('[data-testid="prompt-snippet-add"]').trigger('click');
        await wrapper.get('[data-testid="prompt-snippet-title"]').setValue('Long');
        await wrapper.get('[data-testid="prompt-snippet-body"]').setValue(body);
        await wrapper.get('[data-testid="prompt-snippet-editor"]').trigger('submit');
        await flushPromises();

        expect(settingsStoreMock.updatePromptSnippets).not.toHaveBeenCalled();
        expect(wrapper.get('[data-testid="prompt-snippet-validation"]').text()).toContain('10,000');
        expect(
            (wrapper.get('[data-testid="prompt-snippet-body"]').element as HTMLTextAreaElement)
                .value
        ).toHaveLength(10_001);
    });

    it('user chooses paste and send and sees the mode saved', async () => {
        const wrapper = mount(PromptSnippetSettings, { attachTo: document.body });

        wrapper
            .get('[data-testid="prompt-snippet-insertion-mode"]')
            .element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await flushPromises();
        wrapper
            .get('[data-testid="prompt-snippet-insertion-mode-paste_and_send"]')
            .element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await flushPromises();

        expect(settingsStoreMock.updatePromptSnippetInsertionMode).toHaveBeenCalledWith(
            'paste_and_send'
        );

        wrapper.unmount();
    });

    it('user retries after a failed save and sees the retained draft saved', async () => {
        settingsStoreMock.updatePromptSnippets.mockRejectedValueOnce(
            new Error('disk is read-only')
        );
        const wrapper = mount(PromptSnippetSettings);

        await wrapper.get('[data-testid="prompt-snippet-add"]').trigger('click');
        await wrapper.get('[data-testid="prompt-snippet-title"]').setValue('Review');
        await wrapper
            .get('[data-testid="prompt-snippet-body"]')
            .setValue('Review this change carefully.');
        await wrapper.get('[data-testid="prompt-snippet-editor"]').trigger('submit');
        await flushPromises();

        expect(wrapper.get('[data-testid="prompt-snippet-operation-error"]').text()).toContain(
            'Could not save prompt snippets'
        );
        expect(wrapper.find('[data-testid="prompt-snippet-editor"]').exists()).toBe(true);

        await wrapper.get('[data-testid="prompt-snippet-editor"]').trigger('submit');
        await flushPromises();

        expect(settingsStoreMock.updatePromptSnippets).toHaveBeenCalledTimes(2);
        expect(settingsStoreMock.updatePromptSnippets).toHaveBeenLastCalledWith(
            expect.objectContaining({
                items: expect.arrayContaining([
                    expect.objectContaining({
                        title: 'Review',
                        body: 'Review this change carefully.',
                    }),
                ]),
            })
        );
        expect(wrapper.find('[data-testid="prompt-snippet-editor"]').exists()).toBe(false);
    });

    it('user starts a new draft while an earlier save is pending and keeps the newer draft', async () => {
        let resolveSave: (() => void) | undefined;
        settingsStoreMock.updatePromptSnippets.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveSave = resolve;
                })
        );
        const wrapper = mount(PromptSnippetSettings);

        await wrapper.get('[data-testid="prompt-snippet-add"]').trigger('click');
        await wrapper.get('[data-testid="prompt-snippet-title"]').setValue('Earlier');
        await wrapper.get('[data-testid="prompt-snippet-body"]').setValue('Earlier pending body.');
        await wrapper.get('[data-testid="prompt-snippet-editor"]').trigger('submit');

        await wrapper.findAll('[data-testid="prompt-snippet-editor"] button')[1]!.trigger('click');
        await wrapper.get('[data-testid="prompt-snippet-add"]').trigger('click');
        await wrapper.get('[data-testid="prompt-snippet-title"]').setValue('Newer');
        await wrapper.get('[data-testid="prompt-snippet-body"]').setValue('Newer draft body.');

        resolveSave?.();
        await flushPromises();

        expect(wrapper.find('[data-testid="prompt-snippet-editor"]').exists()).toBe(true);
        expect(
            (wrapper.get('[data-testid="prompt-snippet-title"]').element as HTMLInputElement).value
        ).toBe('Newer');
        expect(
            (wrapper.get('[data-testid="prompt-snippet-body"]').element as HTMLTextAreaElement)
                .value
        ).toBe('Newer draft body.');
    });

    it('user deletes a snippet only after confirming the destructive action', async () => {
        const wrapper = mount(PromptSnippetSettings);

        await wrapper.get('[data-testid="prompt-snippet-delete-snippet-a"]').trigger('click');
        expect(settingsStoreMock.updatePromptSnippets).not.toHaveBeenCalled();

        await wrapper
            .get('[data-testid="prompt-snippet-confirm-delete-snippet-a"]')
            .trigger('click');
        await flushPromises();

        expect(settingsStoreMock.updatePromptSnippets).toHaveBeenCalledWith({
            schemaVersion: 1,
            items: [],
        });
    });

    it('user sees future-version snippets as read-only and cannot open the add form', async () => {
        settingsStoreMock.settings.value.promptSnippets = {
            schemaVersion: 1,
            items: [],
            storageIssue: 'unsupported_version',
        };
        const wrapper = mount(PromptSnippetSettings);
        const add = wrapper.get('[data-testid="prompt-snippet-add"]');

        expect(add.attributes('disabled')).toBeDefined();
        await add.trigger('click');

        expect(wrapper.find('[data-testid="prompt-snippet-editor"]').exists()).toBe(false);
        expect(settingsStoreMock.updatePromptSnippets).not.toHaveBeenCalled();
        expect(wrapper.get('[data-testid="prompt-snippet-storage-error"]').text()).toContain(
            'newer version'
        );
    });

    it('user sees malformed snippet storage shown as an explicit read-only warning', () => {
        setLocale('zh-CN');
        settingsStoreMock.settings.value.promptSnippets = {
            schemaVersion: 1,
            items: [],
            storageIssue: 'invalid_json',
        };
        const wrapper = mount(PromptSnippetSettings);

        expect(
            wrapper.get('[data-testid="prompt-snippet-add"]').attributes('disabled')
        ).toBeDefined();
        expect(wrapper.get('[data-testid="prompt-snippet-storage-error"]').text()).toContain(
            '原数据不会被覆盖'
        );
    });

    it('user repairs snippets with invalid items by editing the valid entries', async () => {
        settingsStoreMock.settings.value.promptSnippets = {
            schemaVersion: 1,
            items: [snippet()],
            storageIssue: 'invalid_items',
        };
        const wrapper = mount(PromptSnippetSettings);

        await wrapper.get('[data-testid="prompt-snippet-edit-snippet-0"]').trigger('click');
        await wrapper.get('[data-testid="prompt-snippet-title"]').setValue('Repaired snippet');
        await wrapper.get('[data-testid="prompt-snippet-editor"]').trigger('submit');
        await flushPromises();

        expect(settingsStoreMock.updatePromptSnippets).toHaveBeenCalledWith(
            expect.objectContaining({
                items: [expect.objectContaining({ title: 'Repaired snippet' })],
            })
        );
    });

    it('user repairs an over-limit collection by deleting a snippet', async () => {
        settingsStoreMock.settings.value.promptSnippets = {
            schemaVersion: 1,
            items: Array.from({ length: 20 }, (_, index) => snippet(index)),
            storageIssue: 'too_many_items',
        };
        const wrapper = mount(PromptSnippetSettings);

        expect(
            wrapper.get('[data-testid="prompt-snippet-add"]').attributes('disabled')
        ).toBeDefined();
        await wrapper.get('[data-testid="prompt-snippet-delete-snippet-0"]').trigger('click');
        await wrapper
            .get('[data-testid="prompt-snippet-confirm-delete-snippet-0"]')
            .trigger('click');
        await flushPromises();

        expect(settingsStoreMock.updatePromptSnippets).toHaveBeenCalledTimes(1);
    });
});
