import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';

import { setLocale } from '@/i18n';

vi.mock('@tiptap/vue-3', () => ({
    NodeViewWrapper: defineComponent({
        setup(_, { attrs, slots }) {
            return () => h('span', attrs, slots.default?.());
        },
    }),
}));
import SkillTagView from '@/views/SearchView/components/SearchBar/tags/skill/SkillTagView.vue';

function render() {
    setLocale('en-US');
    return mount(SkillTagView, {
        props: {
            node: { attrs: { name: 'Summary', path: '/skills/summary/SKILL.md' } } as never,
            decorations: [],
        },
    });
}
describe('given a selected skill is displayed in the editor', () => {
    it('user given a selected skill when reading the draft then sees its name without a separate remove control', () => {
        const wrapper = render();
        expect(wrapper.text()).toBe('Summary');
        expect(wrapper.find('button').exists()).toBe(false);
        expect(wrapper.get('[data-skill-tag]').attributes('contenteditable')).toBe('false');
    });
});
