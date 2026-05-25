import { mount } from '@vue/test-utils';

import { Input } from '@/components/ui/input';

describe('UiInput', () => {
    it('emits model updates when the native input changes', async () => {
        const wrapper = mount(Input, {
            props: {
                modelValue: 'demo',
                placeholder: 'Base URL',
            },
        });

        const input = wrapper.get('input');

        expect(input.attributes('placeholder')).toBe('Base URL');

        await input.setValue('https://api.example.com');

        expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['https://api.example.com']);
    });

    it('re-emits focus and blur so wrapper components can stay reactive', async () => {
        const wrapper = mount(Input, {
            props: {
                modelValue: '',
            },
        });

        const input = wrapper.get('input');

        await input.trigger('focus');
        await input.trigger('blur');

        expect(wrapper.emitted('focus')).toHaveLength(1);
        expect(wrapper.emitted('blur')).toHaveLength(1);
    });
});
