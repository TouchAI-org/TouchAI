import { installSkillCommands } from '@tests/utils/skills';
import { mockTauriCommand } from '@tests/utils/tauri';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';

import SearchBar from '@/views/SearchView/components/SearchBar/index.vue';
import SkillPickerPanel from '@/views/SearchView/components/SearchBar/SkillPickerPanel.vue';

// ProseMirror detects the browser when its module loads.
const vendorDescriptor = vi.hoisted(() => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'vendor');
    Object.defineProperty(navigator, 'vendor', {
        configurable: true,
        value: 'Apple Computer, Inc.',
    });
    return descriptor;
});

const rangeDescriptors = ['getClientRects', 'getBoundingClientRect'].map((name) => ({
    name,
    descriptor: Object.getOwnPropertyDescriptor(Range.prototype, name),
}));

beforeEach(() => {
    installSkillCommands();
    mockTauriCommand('database_query', { rows: [], rowsAffected: 0, lastInsertId: null });
    Object.defineProperties(Range.prototype, {
        getClientRects: { configurable: true, value: () => [] },
        getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
});

afterEach(() => {
    for (const { name, descriptor } of rangeDescriptors) {
        if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
        else Reflect.deleteProperty(Range.prototype, name);
    }
});

afterAll(() => {
    if (vendorDescriptor) Object.defineProperty(navigator, 'vendor', vendorDescriptor);
    else Reflect.deleteProperty(navigator, 'vendor');
});

describe('given WebKit sends composition end before the confirmation key', () => {
    it('user confirms composed text with Enter and selects a skill only on the next Enter', async () => {
        const wrapper = mount(
            defineComponent({
                components: { SearchBar, SkillPickerPanel },
                setup: () => ({ query: ref('') }),
                template: `<SearchBar v-model:query-text="query" :start-dragging="async () => {}">
                    <template #results="{ skillPicker, selectSkill }">
                        <SkillPickerPanel v-if="skillPicker" :picker="skillPicker"
                            @select="selectSkill" />
                    </template>
                </SearchBar>`,
            }),
            { attachTo: document.body, global: { plugins: [createPinia()] } }
        );
        try {
            await flushPromises();
            const editor = wrapper.get<HTMLElement>('.ProseMirror');
            editor.element.focus();
            wrapper.getComponent(SearchBar).vm.insertTextAtCursor('/sum');
            await flushPromises();
            expect(
                wrapper.get('[data-inline-completion]').attributes('data-inline-completion')
            ).toBe('mary');
            vi.spyOn(Date, 'now').mockReturnValue(Date.now());
            await editor.trigger('compositionstart');
            await editor.trigger('compositionend');
            await flushPromises();
            await editor.trigger('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
            await flushPromises();

            expect(wrapper.find('[data-skill-tag]').exists()).toBe(false);
            expect(editor.text()).toBe('/sum');
            expect(wrapper.find('[data-testid="skill-picker-panel"]').exists()).toBe(true);

            await editor.trigger('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
            await flushPromises();
            expect(wrapper.get('[data-skill-tag]').text()).toBe('summary');
        } finally {
            wrapper.unmount();
        }
    });
});
