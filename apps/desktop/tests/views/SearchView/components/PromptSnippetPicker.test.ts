import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { type AppLocale, i18n } from '@/i18n';
import PromptSnippetPicker from '@/views/SearchView/components/PromptSnippetPicker/index.vue';
import type {
    PromptSnippet,
    PromptSnippetPickerData,
} from '@/views/SearchView/components/PromptSnippetPicker/types';

const NOW = '2026-11-22T01:00:00.000Z';

function snippet(id: string, overrides: Partial<PromptSnippet> = {}): PromptSnippet {
    return {
        id,
        title: `Snippet ${id}`,
        body: `Body ${id}`,
        isFavorite: false,
        sortOrder: 0,
        lastUsedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    };
}

function pickerData(
    items: PromptSnippet[],
    overrides: Partial<PromptSnippetPickerData> = {}
): PromptSnippetPickerData {
    return {
        items,
        insertionMode: 'paste_only',
        storageIssue: null,
        toggleShortcut: 'Mod+Shift+P',
        ...overrides,
    };
}

function key(keyValue: string, options: KeyboardEventInit = {}): KeyboardEvent {
    return new KeyboardEvent('keydown', {
        key: keyValue,
        bubbles: true,
        cancelable: true,
        ...options,
    });
}

function pickerVm(wrapper: ReturnType<typeof mount>) {
    return wrapper.vm as unknown as {
        handleOverlayShown: () => void;
        handleKeyDown: (event: KeyboardEvent) => void;
    };
}

describe('given the prompt snippet picker is open', () => {
    let originalLocale: AppLocale;

    beforeEach(() => {
        originalLocale = i18n.global.locale.value;
        i18n.global.locale.value = 'en-US';
        Element.prototype.scrollIntoView = vi.fn();
    });

    afterEach(() => {
        i18n.global.locale.value = originalLocale;
        document.body.innerHTML = '';
    });

    it('user sees favorites first and stable ties in the configured order', () => {
        const wrapper = mount(PromptSnippetPicker, {
            props: {
                data: pickerData([
                    snippet('normal', { sortOrder: 1 }),
                    snippet('favorite-b', { isFavorite: true, sortOrder: 2 }),
                    snippet('favorite-a', { isFavorite: true, sortOrder: 1 }),
                    snippet('normal-first', { sortOrder: 0 }),
                ]),
            },
        });

        expect(
            wrapper
                .findAll('[data-prompt-snippet-id]')
                .map((row) => row.attributes('data-prompt-snippet-id'))
        ).toEqual(['favorite-a', 'favorite-b', 'normal-first', 'normal']);
    });

    it.each(Array.from({ length: 9 }, (_, index) => index + 1))(
        'user selects visible item %i by pressing its index',
        async (index) => {
            const onSelect = vi.fn().mockResolvedValue(undefined);
            const items = Array.from({ length: 9 }, (_, itemIndex) =>
                snippet(`snippet-${itemIndex + 1}`, { sortOrder: itemIndex })
            );
            const wrapper = mount(PromptSnippetPicker, {
                props: { data: pickerData(items), onSelect },
            });

            pickerVm(wrapper).handleKeyDown(key(String(index)));
            await nextTick();

            expect(onSelect).toHaveBeenCalledWith(items[index - 1]);
        }
    );

    it('user moves the highlight with arrows and sees it stop at both bounds', async () => {
        const onSelect = vi.fn().mockResolvedValue(undefined);
        const items = [
            snippet('first', { sortOrder: 0 }),
            snippet('second', { sortOrder: 1 }),
            snippet('third', { sortOrder: 2 }),
        ];
        const wrapper = mount(PromptSnippetPicker, {
            props: { data: pickerData(items), onSelect },
        });
        const vm = pickerVm(wrapper);
        vm.handleOverlayShown();

        vm.handleKeyDown(key('ArrowUp'));
        vm.handleKeyDown(key('ArrowDown'));
        vm.handleKeyDown(key('ArrowDown'));
        vm.handleKeyDown(key('ArrowDown'));
        await nextTick();
        vm.handleKeyDown(key('Enter'));

        expect(onSelect).toHaveBeenCalledWith(items[2]);
    });

    it('user closes the picker with Escape without choosing an item', () => {
        const onSelect = vi.fn();
        const wrapper = mount(PromptSnippetPicker, {
            props: { data: pickerData([snippet('one')]), onSelect },
        });

        pickerVm(wrapper).handleKeyDown(key('Escape'));

        expect(wrapper.emitted('close')).toHaveLength(1);
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('user returns focus to the picker after it is revealed', async () => {
        const wrapper = mount(PromptSnippetPicker, {
            attachTo: document.body,
            props: { data: pickerData([snippet('one')]) },
        });

        pickerVm(wrapper).handleOverlayShown();
        await nextTick();

        expect(document.activeElement).toBe(
            wrapper.get('[data-testid="prompt-snippet-picker"]').element
        );
    });

    it('user sees an empty state when no snippets are available', () => {
        const wrapper = mount(PromptSnippetPicker, {
            props: { data: pickerData([]) },
        });

        expect(wrapper.get('[data-testid="prompt-snippet-picker-empty"]').text()).toContain(
            'No prompt snippets yet'
        );
    });

    it('user sees an unreadable-storage error and cannot choose an item', async () => {
        const onSelect = vi.fn();
        const wrapper = mount(PromptSnippetPicker, {
            props: {
                data: pickerData([], { storageIssue: 'unsupported_version' }),
                onSelect,
            },
        });
        const vm = pickerVm(wrapper);

        vm.handleKeyDown(key('1'));
        vm.handleKeyDown(key('Enter'));
        await nextTick();

        expect(wrapper.get('[data-testid="prompt-snippet-picker-storage-error"]').text()).toContain(
            'newer version'
        );
        expect(onSelect).not.toHaveBeenCalled();
    });

    it('user with a malformed stored payload cannot choose an item that would overwrite it', async () => {
        const onSelect = vi.fn();
        const wrapper = mount(PromptSnippetPicker, {
            props: {
                data: pickerData([snippet('one')], { storageIssue: 'invalid_json' }),
                onSelect,
            },
        });

        pickerVm(wrapper).handleKeyDown(key('1'));
        await nextTick();

        expect(wrapper.get('[data-testid="prompt-snippet-picker-storage-error"]').text()).toContain(
            'original data is not overwritten'
        );
        expect(onSelect).not.toHaveBeenCalled();
    });

    it.each(['invalid_items', 'too_many_items'] as const)(
        'user with repairable %s storage can still choose a valid item',
        async (storageIssue) => {
            const onSelect = vi.fn().mockResolvedValue(undefined);
            const validItem = snippet('one');
            const wrapper = mount(PromptSnippetPicker, {
                props: {
                    data: pickerData([validItem], { storageIssue }),
                    onSelect,
                },
            });

            expect(
                wrapper.find('[data-testid="prompt-snippet-picker-storage-warning"]').exists()
            ).toBe(true);
            pickerVm(wrapper).handleKeyDown(key('1'));
            await nextTick();

            expect(onSelect).toHaveBeenCalledWith(validItem);
        }
    );

    it('user sees a recoverable error when a selection fails', async () => {
        const onSelect = vi.fn().mockRejectedValue(new Error('write failed'));
        const wrapper = mount(PromptSnippetPicker, {
            props: {
                data: pickerData([snippet('one')]),
                onSelect,
            },
        });

        pickerVm(wrapper).handleKeyDown(key('Enter'));
        await flushPromises();
        await nextTick();

        expect(wrapper.get('[role="alert"]').text()).toContain('Could not save');
    });

    it('user with the maximum collection sees at most twenty rows and nine index choices', () => {
        const items = Array.from({ length: 25 }, (_, index) =>
            snippet(`snippet-${index}`, { sortOrder: index })
        );
        const wrapper = mount(PromptSnippetPicker, {
            props: { data: pickerData(items) },
        });

        expect(wrapper.findAll('[data-prompt-snippet-id]')).toHaveLength(20);
        expect(wrapper.findAll('[data-prompt-snippet-index]')).toHaveLength(9);
    });

    it.each([
        ['Enter', { key: 'Enter' }],
        ['index 1', { key: '1' }],
    ] as const)(
        'user pressing %s repeatedly while a selection is pending sends only one choice',
        async (_label, eventInit) => {
            let resolveSelection!: () => void;
            const selection = new Promise<void>((resolve) => {
                resolveSelection = resolve;
            });
            const onSelect = vi.fn(() => selection);
            const wrapper = mount(PromptSnippetPicker, {
                props: {
                    data: pickerData([snippet('one')]),
                    onSelect,
                },
            });
            const vm = pickerVm(wrapper);

            vm.handleKeyDown(key(eventInit.key));
            vm.handleKeyDown(key(eventInit.key, { repeat: true }));
            vm.handleKeyDown(key(eventInit.key));
            await nextTick();

            expect(onSelect).toHaveBeenCalledTimes(1);
            resolveSelection();
            await selection;
        }
    );
});
