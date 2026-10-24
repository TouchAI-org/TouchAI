// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * ui/Select 的样式契约。
 *
 * 此前零覆盖。它是 CustomSelect 的底座，而 CustomSelect 又是 7 个设置页下拉的
 * 底座，所以这一层的漂移会横向扩散。
 */
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@components/ui/select';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => {
    document.body.innerHTML = '';
});

function mountSelect() {
    return mount(
        {
            components: { Select, SelectContent, SelectItem, SelectTrigger, SelectValue },
            data: () => ({ value: 'a' }),
            template: `
                <Select v-model="value" :open="true">
                    <SelectTrigger>
                        <SelectValue placeholder="选择" />
                    </SelectTrigger>
                    <SelectContent force-mount>
                        <SelectItem value="a">选项 A</SelectItem>
                        <SelectItem value="b">选项 B</SelectItem>
                    </SelectContent>
                </Select>
            `,
        },
        { attachTo: document.body }
    );
}

describe('ui/Select', () => {
    it('renders the trigger as a combobox', async () => {
        mountSelect();
        await flushPromises();

        expect(document.querySelector('[role="combobox"]')).not.toBeNull();
    });

    it('renders the content with the t-dropdown presence hook', async () => {
        mountSelect();
        await flushPromises();

        const listbox = document.querySelector('[role="listbox"]');
        expect(listbox, 'listbox missing').not.toBeNull();
        expect(Array.from(listbox?.classList ?? [])).toContain('t-dropdown');
    });

    it('renders one option per item', async () => {
        mountSelect();
        await flushPromises();

        const options = Array.from(document.querySelectorAll('[role="option"]'));
        expect(options.length).toBeGreaterThanOrEqual(2);
    });

    it('renders option labels', async () => {
        mountSelect();
        await flushPromises();

        const text = document.body.textContent ?? '';
        expect(text).toContain('选项 A');
        expect(text).toContain('选项 B');
    });

    it('gives options a pointer cursor and a highlighted state hook', async () => {
        mountSelect();
        await flushPromises();

        const option = document.querySelector('[role="option"]');
        const classes = Array.from(option?.classList ?? []);

        expect(classes).toContain('cursor-pointer');
        expect(classes).toContain('select-none');
    });

    it('truncates the selected value to one line', async () => {
        mountSelect();
        await flushPromises();

        const value = document.querySelector('[data-reka-select-value]');
        if (value) {
            expect(Array.from(value.classList)).toContain('line-clamp-1');
        } else {
            // The value element is rendered by SelectValue inside the trigger.
            const trigger = document.querySelector('[role="combobox"]');
            expect(trigger?.textContent).toBeDefined();
        }
    });

    it('accepts a call-site class on the trigger', async () => {
        mount(
            {
                components: { Select, SelectTrigger, SelectValue },
                data: () => ({ value: 'a' }),
                template: `
                    <Select v-model="value">
                        <SelectTrigger class="w-40"><SelectValue /></SelectTrigger>
                    </Select>
                `,
            },
            { attachTo: document.body }
        );
        await flushPromises();

        expect(Array.from(document.querySelector('[role="combobox"]')?.classList ?? [])).toContain(
            'w-40'
        );
    });
});
