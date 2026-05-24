import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import ModelCapabilityTags from '@/components/ModelCapabilityTags.vue';

describe('ModelCapabilityTags i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('renders model capability badges through the active locale', () => {
        setLocale('en-US');

        const wrapper = mount(ModelCapabilityTags, {
            props: {
                model: {
                    reasoning: 1,
                    tool_call: 1,
                    modalities: JSON.stringify({
                        input: ['text', 'image'],
                        output: ['text'],
                    }),
                    attachment: 1,
                    open_weights: 1,
                },
            },
        });

        expect(wrapper.text()).toContain('Reasoning');
        expect(wrapper.text()).toContain('Tools');
        expect(wrapper.text()).toContain('Multimodal');
        expect(wrapper.text()).toContain('Files');
        expect(wrapper.text()).toContain('Open weights');
        expect(wrapper.text()).not.toContain('推理');
        expect(wrapper.text()).not.toContain('多模态');

        const badges = wrapper.findAll('span');
        expect(badges.length).toBeGreaterThan(0);
        for (const badge of badges) {
            expect(badge.classes()).toContain('whitespace-normal');
            expect(badge.classes()).toContain('break-words');
            expect(badge.classes().some((className) => className.startsWith('max-w-'))).toBe(
                true
            );
        }
    });

    it('localizes the fallback text badge', () => {
        setLocale('en-US');

        const wrapper = mount(ModelCapabilityTags, {
            props: {
                model: {},
            },
        });

        expect(wrapper.text()).toBe('Text');
        expect(wrapper.text()).not.toContain('文本');
    });
});
