import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import DialogShell from '@/components/DialogShell.vue';

describe('user closes a dialog', () => {
    it('user makes retained content inert immediately on close and interactive on reopen', async () => {
        const wrapper = mount(DialogShell, {
            props: { open: true },
            slots: { default: '<button>Create</button>' },
            global: {
                stubs: {
                    Dialog: { template: '<div><slot /></div>' },
                    DialogContent: { template: '<section><slot /></section>' },
                },
            },
        });
        const content = wrapper.find('section');
        expect(content.attributes('inert')).toBeUndefined();

        await wrapper.setProps({ open: false });
        expect(wrapper.find('button').exists()).toBe(true);
        expect(content.attributes('inert')).toBeDefined();

        await wrapper.setProps({ open: true });
        expect(content.attributes('inert')).toBeUndefined();
        wrapper.unmount();
    });
});
