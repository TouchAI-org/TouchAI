import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SectionTabs from '@/views/SettingsView/components/SectionTabs.vue';

afterEach(() => vi.unstubAllGlobals());

describe('user switches a section tab', () => {
    it('user positions the initial indicator without animating from the origin', async () => {
        const wrapper = mount(SectionTabs, {
            props: {
                modelValue: 'one',
                tabs: [
                    { value: 'one', label: 'One' },
                    { value: 'two', label: 'Two' },
                ],
            },
        });
        await wrapper.vm.$nextTick();
        const indicator = wrapper.find('.t-tabs-indicator');
        expect(indicator.exists()).toBe(true);
        expect(indicator.attributes('data-animate')).toBe('false');
        expect(indicator.attributes('aria-hidden')).toBe('true');
        wrapper.unmount();
    });
    it('user sees a selection immediately and does not re-emit the active tab', async () => {
        const wrapper = mount(SectionTabs, {
            props: {
                modelValue: 'one',
                tabs: [
                    { value: 'one', label: 'One' },
                    { value: 'two', label: 'Two' },
                ],
            },
        });
        await wrapper.findAll('button')[0]!.trigger('click');
        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        await wrapper.findAll('button')[1]!.trigger('click');
        expect(wrapper.emitted('update:modelValue')).toEqual([['two']]);
        await wrapper.setProps({ modelValue: 'two' });
        expect(wrapper.find('.t-tabs-indicator').attributes('data-animate')).toBe('true');
        wrapper.unmount();
    });
    it('user disconnects its geometry observer when unmounted', () => {
        const disconnect = vi.fn();
        vi.stubGlobal(
            'ResizeObserver',
            class {
                observe = vi.fn();
                disconnect = disconnect;
            }
        );
        const wrapper = mount(SectionTabs, {
            props: { modelValue: 'one', tabs: [{ value: 'one', label: 'One' }] },
        });
        wrapper.unmount();
        expect(disconnect).toHaveBeenCalledOnce();
    });
});
