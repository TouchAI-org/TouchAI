import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SearchableSelect from '@/components/SearchableSelect.vue';

const wrappers: Array<{ unmount: () => void }> = [];

afterEach(() => {
    wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

function mountSelect() {
    const wrapper = mount(SearchableSelect, {
        attachTo: document.body,
        props: {
            modelValue: null,
            options: [
                { value: 'one', label: 'One' },
                { value: 'two', label: 'Two' },
            ],
        },
        global: { stubs: { AppIcon: true, transition: false } },
    });
    wrappers.push(wrapper);
    return wrapper;
}

describe('user closes a searchable list', () => {
    it('user ignores Enter after Escape while the dropdown is retained for its exit', async () => {
        const wrapper = mountSelect();
        await wrapper.find('button').trigger('click');
        const input = wrapper.find('input');

        await input.trigger('keydown', { key: 'Escape' });
        expect(wrapper.find('button').attributes('aria-expanded')).toBe('false');
        expect(wrapper.find('input').exists()).toBe(true);
        await input.trigger('keydown', { key: 'Enter' });
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    });

    it('user makes leaving content inert and restores keyboard selection on immediate reopen', async () => {
        const wrapper = mountSelect();
        await wrapper.find('button').trigger('click');
        const input = wrapper.find('input');
        const dropdown = input.element.closest('.absolute.top-full');

        await input.trigger('keydown', { key: 'Escape' });
        expect(dropdown?.hasAttribute('inert')).toBe(true);

        await wrapper.find('button').trigger('click');
        const reopenedInput = wrapper.find('input');
        expect(reopenedInput.element.closest('.absolute.top-full')?.hasAttribute('inert')).toBe(
            false
        );
        wrapper.findAll('button').forEach(({ element }) => {
            element.scrollIntoView = vi.fn();
        });
        await reopenedInput.trigger('keydown', { key: 'ArrowDown' });
        await reopenedInput.trigger('keydown', { key: 'Enter' });
        expect(wrapper.emitted('update:modelValue')).toEqual([['two']]);
    });
});
