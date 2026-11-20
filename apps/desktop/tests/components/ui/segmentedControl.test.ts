import { SegmentedControl } from '@components/ui/segmented-control';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

const options = [
    { value: 'key', label: 'API key' },
    { value: 'endpoint', label: 'Base URL' },
];

describe('user switches credential fields with a segmented control', () => {
    it('user sees the shared control styling and the current field announced as selected', () => {
        const wrapper = mount(SegmentedControl, {
            props: { options, modelValue: 'key', ariaLabel: 'Credential field' },
        });
        try {
            expect(wrapper.attributes('aria-label')).toBe('Credential field');
            const buttons = wrapper.findAll('button');
            expect(buttons.map((button) => button.attributes('aria-pressed'))).toEqual([
                'true',
                'false',
            ]);
            expect({
                group: wrapper.classes().sort(),
                option: buttons[0]!.classes().sort(),
            }).toMatchSnapshot();
        } finally {
            wrapper.unmount();
        }
    });

    it('user selects another field and receives the new value', async () => {
        const wrapper = mount(SegmentedControl, { props: { options, modelValue: 'key' } });
        try {
            await wrapper.findAll('button')[1]!.trigger('click');
            expect(wrapper.emitted('update:modelValue')).toEqual([['endpoint']]);
            await wrapper.setProps({ modelValue: 'endpoint' });
            expect(wrapper.findAll('button')[1]!.attributes('aria-pressed')).toBe('true');
        } finally {
            wrapper.unmount();
        }
    });

    it('user cannot change a disabled field or a disabled control', async () => {
        const wrapper = mount(SegmentedControl, {
            props: {
                modelValue: 'key',
                options: [options[0]!, { ...options[1]!, disabled: true }],
            },
        });
        try {
            await wrapper.findAll('button')[1]!.trigger('click');
            expect(wrapper.emitted('update:modelValue')).toBeUndefined();
            await wrapper.setProps({ options, disabled: true });
            expect(wrapper.findAll('button').every((button) => button.element.disabled)).toBe(true);
            await wrapper.findAll('button')[1]!.trigger('click');
            expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        } finally {
            wrapper.unmount();
        }
    });
});
