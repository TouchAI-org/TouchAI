import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import KeyValueRows from '@/views/SettingsView/components/McpTools/components/KeyValueRows.vue';
import McpStdioFields from '@/views/SettingsView/components/McpTools/components/McpStdioFields.vue';

/*
 * The stdio half of an MCP server form is a set of controlled fields: it never
 * keeps its own copy of the values, it reports every keystroke and every
 * add/remove back to the form. Driving the fields and asserting the emitted
 * payload is the only honest way to test that contract, because the component
 * re-renders from the parent's props.
 */

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

function mountFields(props: Record<string, unknown> = {}) {
    return mount(McpStdioFields, {
        props: {
            command: 'npx',
            args: [],
            cwd: '',
            env: [],
            ...props,
        },
    });
}

function fieldInputs(wrapper: ReturnType<typeof mountFields>) {
    return wrapper.findAll('input');
}

/** The add button carries a plus icon; each removable row carries a cross. */
function removeButtons(wrapper: ReturnType<typeof mountFields>) {
    return wrapper.findAll('button').filter((node) => node.find('[data-name="x"]').exists());
}

beforeEach(() => {
    setLocale('zh-CN');
});

describe('user fills in a stdio server', () => {
    it('user sees the command field labelled as required', () => {
        const wrapper = mountFields();

        const label = wrapper.get('label');
        expect(label.text()).toContain('命令');
        expect(label.text()).toContain('*');
    });

    it('user gets the command reported as they type it', async () => {
        const wrapper = mountFields();

        await fieldInputs(wrapper)[0]!.setValue('uvx');

        const emitted = wrapper.emitted('update:command');
        expect(emitted?.[emitted.length - 1]).toEqual(['uvx']);
    });

    it('user gets the working directory reported as they type it', async () => {
        const wrapper = mountFields();

        await fieldInputs(wrapper)[1]!.setValue('/srv/app');

        const emitted = wrapper.emitted('update:cwd');
        expect(emitted?.[emitted.length - 1]).toEqual(['/srv/app']);
    });

    it('user gets the form told to validate when a field loses focus', async () => {
        const wrapper = mountFields();

        await fieldInputs(wrapper)[0]!.trigger('blur');

        expect(wrapper.emitted('blur')).toHaveLength(1);
    });

    it('user gets the form told to validate when an argument field loses focus', async () => {
        const wrapper = mountFields({ args: ['mcp-server'] });

        // Command, the single argument, then cwd.
        await fieldInputs(wrapper)[1]!.trigger('blur');

        expect(wrapper.emitted('blur')).toHaveLength(1);
    });

    it('user gets the form told to validate when the working directory loses focus', async () => {
        const wrapper = mountFields();

        await fieldInputs(wrapper)[1]!.trigger('blur');

        expect(wrapper.emitted('blur')).toHaveLength(1);
    });

    it('user sees the command they typed rendered back into the field', () => {
        const wrapper = mountFields({ command: 'pnpm dlx' });

        expect(fieldInputs(wrapper)[0]!.element.value).toBe('pnpm dlx');
    });
});

describe('user manages the argument list', () => {
    it('user gets an empty argument appended from the add button', async () => {
        const wrapper = mountFields({ args: ['mcp-server'] });

        await wrapper.get('button').trigger('click');

        const emitted = wrapper.emitted('update:args');
        expect(emitted?.[emitted.length - 1]).toEqual([['mcp-server', '']]);
    });

    it('user gets one more argument field each time they add one', async () => {
        const wrapper = mountFields({ args: ['a'] });

        await wrapper.setProps({ args: ['a', ''] });

        // command + cwd + two arguments
        expect(fieldInputs(wrapper)).toHaveLength(4);
    });

    it('user gets the argument they edited reported back in place', async () => {
        const wrapper = mountFields({ args: ['mcp-server', '--root'] });

        // Command first, then one input per argument in order.
        await fieldInputs(wrapper)[1]!.setValue('--verbose');

        const emitted = wrapper.emitted('update:args');
        expect(emitted?.[emitted.length - 1]).toEqual([['--verbose', '--root']]);
    });

    it('user gets the row they removed taken out of the list', async () => {
        const wrapper = mountFields({ args: ['mcp-server', '--root'] });

        await removeButtons(wrapper)[1]!.trigger('click');

        const emitted = wrapper.emitted('update:args');
        expect(emitted?.[emitted.length - 1]).toEqual([['mcp-server']]);
    });

    it('user gets the form told to validate after removing an argument', async () => {
        const wrapper = mountFields({ args: ['mcp-server'] });

        await removeButtons(wrapper)[0]!.trigger('click');

        expect(wrapper.emitted('blur')).toHaveLength(1);
    });

    it('user sees only the command and working directory before adding an argument', () => {
        const wrapper = mountFields();

        // The argument section is still labelled; it just has no rows yet.
        expect(wrapper.text()).toContain('参数');
        expect(fieldInputs(wrapper)).toHaveLength(2);
        expect(removeButtons(wrapper)).toHaveLength(0);
    });
});

describe('user manages the environment rows', () => {
    it('user gets the env section reported upward when a row is added', async () => {
        const wrapper = mountFields();
        const keyValueSection = wrapper.findComponent(KeyValueRows);

        keyValueSection.vm.$emit('update:rows', [{ key: 'TOKEN', value: 'abc' }]);
        await wrapper.vm.$nextTick();

        const emitted = wrapper.emitted('update:env');
        expect(emitted?.[emitted.length - 1]).toEqual([[{ key: 'TOKEN', value: 'abc' }]]);
    });

    it('user gets the form told to validate when the env section loses focus', async () => {
        const wrapper = mountFields();
        const keyValueSection = wrapper.findComponent(KeyValueRows);

        keyValueSection.vm.$emit('blur');
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('blur')).toHaveLength(1);
    });

    it('user sees their environment rows handed to the key-value editor', () => {
        const rows = [{ key: 'TOKEN', value: 'abc' }];
        const wrapper = mountFields({ env: rows });

        expect(wrapper.findComponent(KeyValueRows).props('rows')).toEqual(rows);
    });
});

describe('user edits a plain key-value block', () => {
    function mountRows(rows: Array<{ key: string; value: string }> = []) {
        return mount(KeyValueRows, {
            props: {
                rows,
                title: '环境变量',
                keyPlaceholder: '键',
                valuePlaceholder: '值',
            },
        });
    }

    it('user gets a blank row appended from the add button', async () => {
        const wrapper = mountRows([{ key: 'A', value: '1' }]);

        await wrapper.get('button').trigger('click');

        expect(wrapper.emitted('update:rows')?.[0]).toEqual([
            [
                { key: 'A', value: '1' },
                { key: '', value: '' },
            ],
        ]);
    });

    it('user gets the key they typed reported without disturbing the value', async () => {
        const wrapper = mountRows([{ key: 'A', value: '1' }]);

        await wrapper.findAll('input')[0]!.setValue('B');

        expect(wrapper.emitted('update:rows')?.[0]).toEqual([[{ key: 'B', value: '1' }]]);
    });

    it('user gets the value they typed reported without disturbing the key', async () => {
        const wrapper = mountRows([{ key: 'A', value: '1' }]);

        await wrapper.findAll('input')[1]!.setValue('2');

        expect(wrapper.emitted('update:rows')?.[0]).toEqual([[{ key: 'A', value: '2' }]]);
    });

    it('user gets the row they removed taken out', async () => {
        const wrapper = mountRows([
            { key: 'A', value: '1' },
            { key: 'B', value: '2' },
        ]);

        await wrapper.findAll('button')[1]!.trigger('click');

        expect(wrapper.emitted('update:rows')?.[0]).toEqual([[{ key: 'B', value: '2' }]]);
    });

    it('user gets the form told to validate after removing a row', async () => {
        const wrapper = mountRows([{ key: 'A', value: '1' }]);

        await wrapper.findAll('button')[1]!.trigger('click');

        expect(wrapper.emitted('blur')).toHaveLength(1);
    });

    it('user gets a test id on each key field when the caller asks for one', () => {
        const wrapper = mount(KeyValueRows, {
            props: {
                rows: [{ key: 'A', value: '1' }],
                title: '环境变量',
                keyPlaceholder: '键',
                valuePlaceholder: '值',
                testIdPrefix: 'env',
            },
        });

        expect(wrapper.findAll('input')[0]!.attributes('data-testid')).toBe('env-0');
    });

    it('user sees the block title they were given', () => {
        const wrapper = mountRows();

        expect(wrapper.get('label').text()).toBe('环境变量');
    });
});
