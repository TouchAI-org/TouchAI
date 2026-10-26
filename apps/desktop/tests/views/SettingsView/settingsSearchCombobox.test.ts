import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';
import SettingsSearch from '@/views/SettingsView/components/SettingsSearch.vue';

/*
 * The sidebar search is a keyboard-first combobox: a user types a word, walks the
 * matching rows with the arrow keys and presses Enter. Every branch below is one
 * step of that loop, asserted through the rendered list and the emitted events
 * rather than the component's internal cursor.
 */

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

function mountSearch(props: Record<string, unknown> = {}) {
    return mount(SettingsSearch, {
        props: { collapsed: false, modelValue: '', ...props },
        attachTo: document.body,
    });
}

type Wrapper = ReturnType<typeof mountSearch>;

function input(wrapper: Wrapper) {
    return wrapper.get('[data-testid="settings-search-input"]');
}

function options(wrapper: Wrapper) {
    return wrapper.findAll('[role="option"]');
}

function selectedOption(wrapper: Wrapper) {
    return wrapper.get('[role="option"][aria-selected="true"]');
}

/** The most recent query the box reported upward. */
function lastQuery(wrapper: Wrapper) {
    const emitted = wrapper.emitted('update:modelValue') ?? [];
    return emitted[emitted.length - 1];
}

async function searchFor(wrapper: Wrapper, text: string) {
    await input(wrapper).setValue(text);
    await nextTick();
}

async function press(wrapper: Wrapper, key: string, init: KeyboardEventInit = {}) {
    await input(wrapper).trigger('keydown', { key, ...init });
    await nextTick();
}

beforeEach(() => {
    setLocale('zh-CN');
    // jsdom has no layout, so scrollIntoView does not exist on elements.
    Element.prototype.scrollIntoView = vi.fn();
});

describe('user searches for a setting', () => {
    it('user sees the search box ready with a translated placeholder', () => {
        const wrapper = mountSearch();

        expect(input(wrapper).attributes('placeholder')).toBe('搜索设置项');
        expect(input(wrapper).attributes('role')).toBe('combobox');
    });

    it('user sees matching settings listed as they type', async () => {
        const wrapper = mountSearch();

        await searchFor(wrapper, '开机');

        expect(options(wrapper).length).toBeGreaterThan(0);
        expect(wrapper.get('[data-testid="settings-search-results"]').text()).toContain('开机');
    });

    it('user sees the first match highlighted before touching the arrow keys', async () => {
        const wrapper = mountSearch();

        await searchFor(wrapper, '开机');

        expect(selectedOption(wrapper).attributes('id')).toBe(
            `${options(wrapper)[0]!.attributes('id')}`
        );
    });

    it('user is told when nothing matches what they typed', async () => {
        const wrapper = mountSearch();

        await searchFor(wrapper, 'zzzz-nothing-zzzz');

        expect(options(wrapper)).toHaveLength(0);
        expect(wrapper.get('[role="status"]').text()).toBe('没有找到匹配的设置项');
    });

    it('user sees no result panel before typing anything', () => {
        const wrapper = mountSearch();

        expect(wrapper.find('[data-testid="settings-search-results"]').exists()).toBe(false);
    });

    it('user sees the search box expand into a full pane while they are looking for something', async () => {
        const wrapper = mountSearch();

        await searchFor(wrapper, '开机');

        expect(wrapper.get('[data-testid="settings-search"]').classes()).toContain('flex-1');
    });

    it('user gets the query reported so the sidebar can hide its destination list', async () => {
        const wrapper = mountSearch();

        await searchFor(wrapper, '开机');

        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted?.[emitted.length - 1]).toEqual(['开机']);
    });

    it('user gets a clear button once there is something to clear', async () => {
        const wrapper = mountSearch();

        expect(wrapper.find('[aria-label="清除"]').exists()).toBe(false);
        await searchFor(wrapper, '开机');
        expect(wrapper.find('[aria-label="清除"]').exists()).toBe(true);
    });
});

describe('user picks a result', () => {
    it('user gets the highlighted setting opened when pressing Enter', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, '开机');

        await press(wrapper, 'Enter');

        const selected = wrapper.emitted('select')?.[0]?.[0] as { section: string };
        expect(selected.section).toBe('general');
    });

    it('user gets the query cleared after choosing a setting', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, '开机');

        await press(wrapper, 'Enter');

        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted?.[emitted.length - 1]).toEqual(['']);
    });

    it('user gets the row they clicked opened', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, '开机');

        await options(wrapper)[0]!.trigger('click');

        expect(wrapper.emitted('select')).toHaveLength(1);
    });

    it('user gets nothing opened when pressing Enter with no matches', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, 'zzzz-nothing-zzzz');

        await press(wrapper, 'Enter');

        expect(wrapper.emitted('select')).toBeUndefined();
    });
});

describe('user walks the results with the arrow keys', () => {
    async function twoResultQuery(wrapper: Wrapper) {
        await searchFor(wrapper, '开机');
        // "start" matches several settings in both languages.
        if (options(wrapper).length < 2) {
            await searchFor(wrapper, 'start');
        }
        expect(options(wrapper).length).toBeGreaterThan(1);
    }

    it('user gets the next result highlighted on arrow down', async () => {
        const wrapper = mountSearch();
        await twoResultQuery(wrapper);
        const first = selectedOption(wrapper).attributes('id');

        await press(wrapper, 'ArrowDown');

        expect(selectedOption(wrapper).attributes('id')).not.toBe(first);
    });

    it('user gets the last result highlighted on arrow up', async () => {
        const wrapper = mountSearch();
        await twoResultQuery(wrapper);

        await press(wrapper, 'ArrowUp');

        expect(selectedOption(wrapper).attributes('id')).toBe(
            options(wrapper)[options(wrapper).length - 1]!.attributes('id')
        );
    });

    it('user wraps back to the first result after the last one', async () => {
        const wrapper = mountSearch();
        await twoResultQuery(wrapper);
        const total = options(wrapper).length;

        for (let step = 0; step < total; step += 1) {
            await press(wrapper, 'ArrowDown');
        }

        expect(selectedOption(wrapper).attributes('id')).toBe(
            options(wrapper)[0]!.attributes('id')
        );
    });

    it('user gets the arrows ignored when there is nothing to walk', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, 'zzzz-nothing-zzzz');

        await press(wrapper, 'ArrowDown');

        expect(options(wrapper)).toHaveLength(0);
    });

    it('user gets the highlighted row scrolled into view as they walk', async () => {
        const scrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView');
        const wrapper = mountSearch();
        await twoResultQuery(wrapper);

        await press(wrapper, 'ArrowDown');

        expect(scrollIntoView).toHaveBeenCalled();
    });

    it('user gets the first result highlighted again after a new search', async () => {
        const wrapper = mountSearch();
        await twoResultQuery(wrapper);
        await press(wrapper, 'ArrowDown');

        await searchFor(wrapper, '开机');

        expect(selectedOption(wrapper).attributes('id')).toBe(
            options(wrapper)[0]!.attributes('id')
        );
    });

    it('user searching in a language they are not reading still finds the setting', async () => {
        const wrapper = mountSearch();

        await searchFor(wrapper, 'minimized');

        expect(
            wrapper.get('[data-testid="settings-search-results"]').text().length
        ).toBeGreaterThan(0);
        expect(options(wrapper).length).toBeGreaterThan(0);
    });
});

describe('user clears the search', () => {
    it('user gets an empty box from the clear button', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, '开机');

        await wrapper.get('[aria-label="清除"]').trigger('click');
        await nextTick();

        expect((input(wrapper).element as HTMLInputElement).value).toBe('');
        expect(wrapper.find('[data-testid="settings-search-results"]').exists()).toBe(false);
    });

    it('user gets an empty box from the Escape key', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, '开机');

        await press(wrapper, 'Escape');

        const emitted = wrapper.emitted('update:modelValue');
        expect(emitted?.[emitted.length - 1]).toEqual(['']);
    });

    it('user keeps the box focused after clearing so they can keep typing', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, '开机');

        await wrapper.get('[aria-label="清除"]').trigger('click');
        await nextTick();
        await nextTick();

        expect(document.activeElement).toBe(input(wrapper).element);
    });

    it('user gets their keystrokes left alone while the input method is composing', async () => {
        const wrapper = mountSearch();
        await searchFor(wrapper, '开机');

        await press(wrapper, 'Escape', { isComposing: true });

        expect(lastQuery(wrapper)).toEqual(['开机']);
        expect(options(wrapper).length).toBeGreaterThan(0);
    });

    it('user gets the query dropped when the sidebar collapses', async () => {
        const wrapper = mountSearch({ modelValue: '开机' });
        await nextTick();

        await wrapper.setProps({ collapsed: true });
        await nextTick();

        expect(lastQuery(wrapper)).toEqual(['']);
    });

    it('user keeps the query when the sidebar expands', async () => {
        const wrapper = mountSearch({ modelValue: '开机' });
        await nextTick();
        const before = wrapper.emitted('update:modelValue')?.length ?? 0;

        await wrapper.setProps({ collapsed: false });
        await nextTick();

        expect(wrapper.emitted('update:modelValue')?.length ?? 0).toBe(before);
    });

    it('user gets the query kept when the sidebar goes from collapsed back to open', async () => {
        const wrapper = mountSearch({ collapsed: true, modelValue: '' });
        await nextTick();

        await wrapper.setProps({ collapsed: false });
        await nextTick();

        // Expanding never discards what the user already typed.
        expect(wrapper.emitted('update:modelValue') ?? []).toHaveLength(0);
    });
});

describe('user opens the search from a collapsed sidebar', () => {
    it('user sees a single search button instead of the whole box', () => {
        const wrapper = mountSearch({ collapsed: true });

        expect(wrapper.find('[data-testid="settings-search"]').exists()).toBe(false);
        expect(wrapper.get('button').attributes('aria-label')).toBe('搜索设置项');
    });

    it('user gets the sidebar expanded when they press the search button', async () => {
        const wrapper = mountSearch({ collapsed: true });

        await wrapper.get('button').trigger('click');
        await nextTick();

        expect(wrapper.emitted('expand')).toHaveLength(1);
    });
});
