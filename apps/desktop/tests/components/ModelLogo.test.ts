import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import ModelLogo from '@/components/ModelLogo.vue';

/**
 * The model logo is the only thing identifying which provider a row belongs to. A model that
 * maps to the wrong logo misleads the user, and a model that maps to none has to fall back to a
 * readable letter rather than an empty circle.
 */
function mountLogo(props: Record<string, unknown>) {
    return mount(ModelLogo, { props });
}

describe('user sees which provider a model belongs to', () => {
    it('user gets the openai logo for a gpt model', () => {
        const wrapper = mountLogo({ modelId: 'gpt-4o' });

        expect(wrapper.find('img').attributes('alt')).toBe('gpt-4o');
        wrapper.unmount();
    });

    it('user gets the claude logo for an anthropic model', () => {
        const wrapper = mountLogo({ modelId: 'claude-sonnet-4' });

        expect(wrapper.find('img').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user gets a logo whatever the casing of the model id', () => {
        const upper = mountLogo({ modelId: 'GPT-4O' });
        const lower = mountLogo({ modelId: 'gpt-4o' });

        // The same model must not change logo because a provider wrote its id in capitals.
        expect(upper.find('img').attributes('src')).toBe(lower.find('img').attributes('src'));
        upper.unmount();
        lower.unmount();
    });

    it('user gets the fallback letter for an unknown model', () => {
        const wrapper = mountLogo({ modelId: 'some-local-model', name: 'Local Llama' });

        expect(wrapper.find('img').exists()).toBe(false);
        expect(wrapper.text()).toBe('L');
        wrapper.unmount();
    });

    it('user gets the fallback letter taken from the id when there is no name', () => {
        const wrapper = mountLogo({ modelId: 'unknown-model' });

        expect(wrapper.text()).toBe('u');
        wrapper.unmount();
    });

    it('user gets a question mark when there is neither a name nor an id', () => {
        const wrapper = mountLogo({ modelId: '' });

        expect(wrapper.text()).toBe('?');
        wrapper.unmount();
    });

    it('user gets the accessible name from the model name when one is given', () => {
        const wrapper = mountLogo({ modelId: 'gpt-4o', name: 'GPT-4o mini' });

        expect(wrapper.find('img').attributes('alt')).toBe('GPT-4o mini');
        wrapper.unmount();
    });

    it('user gets each size rendered at its own scale', () => {
        const small = mountLogo({ modelId: 'gpt-4o', size: 'sm' });
        const medium = mountLogo({ modelId: 'gpt-4o' });
        const large = mountLogo({ modelId: 'gpt-4o', size: 'lg' });

        expect(small.find('img').classes()).toContain('h-6');
        expect(medium.find('img').classes()).toContain('h-8');
        expect(large.find('img').classes()).toContain('h-10');
        small.unmount();
        medium.unmount();
        large.unmount();
    });

    it('user gets the fallback sized like the logo', () => {
        const small = mountLogo({ modelId: 'unknown', size: 'sm' });

        expect(small.find('div').classes()).toContain('h-6');
        small.unmount();
    });

    it('user gets the logo marked so it is never translated or mirrored', () => {
        const wrapper = mountLogo({ modelId: 'gpt-4o' });

        // The logo is an asset, not copy: translation and RTL mirroring would break it.
        const img = wrapper.find('img');
        expect(img.attributes('data-no-i18n')).toBe('true');
        expect(img.attributes('translate')).toBe('no');
        wrapper.unmount();
    });

    it('user gets the fallback marked the same way', () => {
        const wrapper = mountLogo({ modelId: 'unknown' });

        const fallback = wrapper.find('div');
        expect(fallback.attributes('data-no-i18n')).toBe('true');
        expect(fallback.attributes('translate')).toBe('no');
        wrapper.unmount();
    });
});
