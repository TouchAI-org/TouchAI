import { SegmentedControl } from '@components/ui/segmented-control';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

const options = [
    { value: 'key', label: 'API key' },
    { value: 'endpoint', label: 'Base URL' },
];

function indicatorWidth(wrapper: ReturnType<typeof mount>) {
    const indicator = wrapper.find('span');
    if (!indicator.exists()) return Number.NaN;
    return Number.parseFloat(
        /width:\s*([\d.]+)px/.exec(indicator.attributes('style') ?? '')?.[1] ?? '0'
    );
}

async function indicatorReaches(wrapper: ReturnType<typeof mount>, width: number) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        if (Math.abs(indicatorWidth(wrapper) - width) < 0.5) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

describe('user switches credential fields with a segmented control', () => {
    it('user sees the group semantics and the current field announced as selected', () => {
        const wrapper = mount(SegmentedControl, {
            props: { options, modelValue: 'key', ariaLabel: 'Credential field' },
        });
        try {
            expect(wrapper.attributes('role')).toBe('group');
            expect(wrapper.attributes('aria-label')).toBe('Credential field');
            const buttons = wrapper.findAll('button');
            expect(buttons.map((button) => button.text())).toEqual(['API key', 'Base URL']);
            expect(buttons.map((button) => button.attributes('type'))).toEqual([
                'button',
                'button',
            ]);
            expect(buttons.map((button) => button.attributes('aria-pressed'))).toEqual([
                'true',
                'false',
            ]);
        } finally {
            wrapper.unmount();
        }
    });

    it('user sees the indicator follow labels that change in place', async () => {
        const widthSpy = vi
            .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
            .mockImplementation(function (this: HTMLElement) {
                return (this.textContent ?? '').trim().length * 8;
            });
        const wrapper = mount(SegmentedControl, {
            props: {
                options: [
                    { value: 'key', label: 'A' },
                    { value: 'endpoint', label: 'Long label' },
                ],
                modelValue: 'endpoint',
            },
        });
        try {
            expect(await indicatorReaches(wrapper, 80)).toBe(true);
            // 交换标签但保留选中的 value，根元素宽度不变，只有标签串能触发重新测量。
            await wrapper.setProps({
                options: [
                    { value: 'key', label: 'Long label' },
                    { value: 'endpoint', label: 'A' },
                ],
            });
            expect(await indicatorReaches(wrapper, 8)).toBe(true);
        } finally {
            wrapper.unmount();
            widthSpy.mockRestore();
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
