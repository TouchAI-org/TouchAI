import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import KeyValueRows from '@/views/SettingsView/components/McpTools/components/KeyValueRows.vue';

/**
 * The same row editor backs both MCP headers and stdio environment variables. It holds no data
 * of its own: every keystroke and every add or remove has to reach the parent, or the user edits
 * a form that silently keeps the old values.
 */
function mountRows(rows: Array<{ key: string; value: string }> = [], prefix?: string) {
    return mount(KeyValueRows, {
        props: {
            rows,
            title: 'Headers',
            keyPlaceholder: 'Name',
            valuePlaceholder: 'Value',
            testIdPrefix: prefix,
        },
        global: {
            stubs: {
                AppIcon: { props: ['name'], template: '<i :data-icon="name" />' },
            },
        },
    });
}

function lastRows(wrapper: ReturnType<typeof mountRows>) {
    const events = wrapper.emitted('update:rows');
    expect(events, 'no rows update was emitted').toBeTruthy();
    return events![events!.length - 1]![0] as Array<{ key: string; value: string }>;
}

describe('user edits a list of key and value rows', () => {
    it('user adds a row and an empty pair is appended', async () => {
        const wrapper = mountRows([{ key: 'a', value: '1' }]);

        await wrapper
            .find('[data-icon="plus"]')
            .element.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(lastRows(wrapper)).toEqual([
            { key: 'a', value: '1' },
            { key: '', value: '' },
        ]);
        wrapper.unmount();
    });

    it('user removes a row and only that row leaves the list', async () => {
        const wrapper = mountRows([
            { key: 'a', value: '1' },
            { key: 'b', value: '2' },
        ]);

        const removeButtons = wrapper
            .findAll('button')
            .filter((button) => button.find('[data-icon="x"]').exists());
        await removeButtons[0]!.trigger('click');

        expect(lastRows(wrapper)).toEqual([{ key: 'b', value: '2' }]);
        wrapper.unmount();
    });

    it('user gets a blur reported after removing a row', async () => {
        const wrapper = mountRows([{ key: 'a', value: '1' }]);

        const removeButtons = wrapper
            .findAll('button')
            .filter((button) => button.find('[data-icon="x"]').exists());
        await removeButtons[0]!.trigger('click');

        // The parent saves on blur, so a removal that does not report blur is never saved.
        expect(wrapper.emitted('blur')).toHaveLength(1);
        wrapper.unmount();
    });

    it('user sees the title and both placeholders', () => {
        const wrapper = mountRows([{ key: 'a', value: '1' }]);

        expect(wrapper.text()).toContain('Headers');
        const inputs = wrapper.findAll('input');
        expect(inputs[0]!.attributes('placeholder')).toBe('Name');
        expect(inputs[1]!.attributes('placeholder')).toBe('Value');
        wrapper.unmount();
    });

    it('user gets no rows rendered when the list is empty', () => {
        const wrapper = mountRows([]);

        expect(wrapper.findAll('input')).toHaveLength(0);
        wrapper.unmount();
    });

    it('user gets the row test id derived from the prefix', () => {
        const wrapper = mountRows([{ key: 'a', value: '1' }], 'mcp-header');

        // The E2E suite addresses these fields by id, so the prefix has to reach the DOM.
        expect(wrapper.findAll('input')[0]!.attributes('data-testid')).toBe('mcp-header-0');
        wrapper.unmount();
    });
});
