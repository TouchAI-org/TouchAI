import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';

import type { SkillPickerState } from '@/views/SearchView/components/SearchBar/composables/useSkillAutocomplete';
import SkillPickerPanel from '@/views/SearchView/components/SearchBar/SkillPickerPanel.vue';

enableAutoUnmount(afterEach);

function picker(count = 12): SkillPickerState {
    return {
        listId: 'skill-growth',
        query: '',
        loading: false,
        error: false,
        candidates: Array.from({ length: count }, (_, index) => ({
            name: `skill-${index}`,
            path: `/skills/skill-${index}/SKILL.md`,
            directory: `/skills/skill-${index}`,
            description: `Skill ${index}`,
            shortDescription: null,
        })),
        highlightedIndex: -1,
    };
}

describe('given skills use the shared result list', () => {
    it('user given more than the first batch of skills when scrolling downward then expands once before normal scrolling', async () => {
        const wrapper = mount(SkillPickerPanel, { props: { picker: picker(), maxHeight: 600 } });
        const viewport = wrapper.get<HTMLElement>('[data-slot="result-panel-viewport"]');
        const initialHeight = Number.parseFloat(viewport.element.style.height);
        expect(initialHeight).toBeGreaterThan(0);
        await viewport.trigger('wheel', { deltaY: -120 });
        expect(Number.parseFloat(viewport.element.style.height)).toBe(initialHeight);
        await viewport.trigger('wheel', { deltaY: 120 });
        const expandedHeight = Number.parseFloat(viewport.element.style.height);
        expect(expandedHeight).toBeGreaterThan(initialHeight);
        await viewport.trigger('wheel', { deltaY: 120 });
        expect(Number.parseFloat(viewport.element.style.height)).toBe(expandedHeight);
    });

    it('user given a skill beyond the first batch when navigating by keyboard then expands the same viewport', async () => {
        const state = picker();
        const wrapper = mount(SkillPickerPanel, { props: { picker: state, maxHeight: 600 } });
        const viewport = wrapper.get<HTMLElement>('[data-slot="result-panel-viewport"]');
        const initialHeight = Number.parseFloat(viewport.element.style.height);
        await wrapper.setProps({ picker: { ...state, highlightedIndex: 6 } });
        expect(Number.parseFloat(viewport.element.style.height)).toBeGreaterThan(initialHeight);
        await wrapper.setProps({ picker: picker(1) });
        expect(Number.parseFloat(viewport.element.style.height)).toBeLessThan(initialHeight);
    });

    it.each([{ ctrlKey: true }, { deltaX: 240 }])(
        'user given the first batch when zooming or scrolling sideways %j then keeps the current height',
        async (modifiers) => {
            const wrapper = mount(SkillPickerPanel, {
                props: { picker: picker(), maxHeight: 600 },
            });
            const viewport = wrapper.get<HTMLElement>('[data-slot="result-panel-viewport"]');
            const initialHeight = viewport.element.style.height;
            viewport.element.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, ...modifiers }));
            await nextTick();
            expect(viewport.element.style.height).toBe(initialHeight);
        }
    );

    it('user given an expanded list when editing the query then retains the viewport while matches refresh', async () => {
        const state = picker();
        const wrapper = mount(SkillPickerPanel, { props: { picker: state, maxHeight: 600 } });
        const viewport = wrapper.get<HTMLElement>('[data-slot="result-panel-viewport"]');
        await viewport.trigger('wheel', { deltaY: 120 });
        const expandedHeight = viewport.element.style.height;
        await wrapper.setProps({ picker: { ...state, query: 'skill', loading: true } });
        await viewport.trigger('wheel', { deltaY: 120 });
        expect(viewport.element.style.height).toBe(expandedHeight);
        await wrapper.setProps({ picker: { ...state, query: 'skill' } });
        expect(wrapper.get('[data-slot="result-panel-viewport"]').element).toBe(viewport.element);
        expect(viewport.element.style.height).toBe(expandedHeight);
    });

    it('user given a single matching skill when scrolling then keeps one row of content', async () => {
        const wrapper = mount(SkillPickerPanel, { props: { picker: picker(1), maxHeight: 600 } });
        const viewport = wrapper.get<HTMLElement>('[data-slot="result-panel-viewport"]');
        const height = Number.parseFloat(viewport.element.style.height);
        expect(height).toBeGreaterThan(0);
        expect(height).toBeLessThan(100);
        await viewport.trigger('wheel', { deltaY: 120 });
        expect(Number.parseFloat(viewport.element.style.height)).toBe(height);
    });

    it('user given a compact conversation picker when scrolling skills then keeps complete rows within its height limit without a second stage', async () => {
        const wrapper = mount(SkillPickerPanel, {
            props: { picker: picker(), maxHeight: 300, compact: true },
        });
        const viewport = wrapper.get<HTMLElement>('[data-slot="result-panel-viewport"]');
        const initialHeight = Number.parseFloat(viewport.element.style.height);
        expect(initialHeight).toBeLessThan(300);
        expect(initialHeight % 32).toBe(0);
        await viewport.trigger('wheel', { deltaY: 120 });
        expect(Number.parseFloat(viewport.element.style.height)).toBe(initialHeight);
    });
});
