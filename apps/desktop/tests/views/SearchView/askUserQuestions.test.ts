// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import AskUserQuestions from '@/views/SearchView/components/AskUser/AskUserQuestions.vue';

/*
 * AskUser had no test coverage before this file. That mattered for this change:
 * the panel keeps its own scoped theme layer (.ask-user-panel in
 * styles/tokens.css) while the design system now also declares --color-card,
 * --color-hover and --color-active globally. Those two layers coexisting is
 * exactly the kind of thing that looks fine in a class snapshot and renders wrong
 * on screen, so these assertions are about what reaches the DOM.
 *
 * jsdom does not run Tailwind, so computed colours are out of reach here. What is
 * checkable is the structure the styling hangs off: the scoped wrapper class, the
 * selectable rows, and the other-answer field. The visual side is covered by
 * running both builds side by side.
 */

const questions = [
    {
        id: 'q1',
        title: '设计系统回归验证',
        subtitle: '选择一项继续',
        options: [
            { id: 'serif', title: '思源宋体', description: '标题与正文' },
            { id: 'mono', title: '等宽字体', description: '代码块' },
            { id: 'sans', title: '系统无衬线', description: '界面元素' },
        ],
        allowOther: true,
    },
];

beforeAll(() => {
    // The panel measures its own content height to animate between questions.
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
});

function mountQuestions(overrides: Record<string, unknown> = {}) {
    return mount(AskUserQuestions, {
        props: { questions, ...overrides },
        attachTo: document.body,
    });
}

describe('AskUserQuestions', () => {
    it('renders the question and every option', () => {
        const wrapper = mountQuestions();

        expect(wrapper.text()).toContain('设计系统回归验证');
        expect(wrapper.text()).toContain('思源宋体');
        expect(wrapper.text()).toContain('等宽字体');
        expect(wrapper.text()).toContain('系统无衬线');

        wrapper.unmount();
    });

    it('renders one selectable row per option', () => {
        /*
         * Rows are divs carrying role="radio" for single-select and "checkbox" for
         * multi-select, with a click handler — not buttons. Keying off the role
         * rather than the tag keeps this from silently passing on an empty set if
         * the markup changes shape.
         */
        const wrapper = mountQuestions();

        const rows = wrapper.findAll('[role="radio"]');
        expect(rows).toHaveLength(3);
        expect(rows[0]!.attributes('data-state')).toBe('unchecked');

        wrapper.unmount();
    });

    it('selects an option when its row is clicked', async () => {
        const wrapper = mountQuestions();

        const rows = wrapper.findAll('[role="radio"]');
        const mono = rows.find((row) => row.text().includes('等宽字体'));
        expect(mono).toBeTruthy();

        await mono!.trigger('click');

        const emitted = wrapper.emitted('update:answers');
        expect(emitted).toBeTruthy();
        const latest = emitted![emitted!.length - 1]![0] as Record<
            string,
            { selectedIds: string[] }
        >;
        expect(latest.q1!.selectedIds).toContain('mono');

        wrapper.unmount();
    });

    it('offers the other-answer field when the question allows it', () => {
        const wrapper = mountQuestions();

        expect(wrapper.find('input, textarea').exists()).toBe(true);

        wrapper.unmount();
    });

    it('does not render the other-answer field when the question forbids it', () => {
        const wrapper = mountQuestions({
            questions: [{ ...questions[0], allowOther: false }],
        });

        expect(wrapper.find('input, textarea').exists()).toBe(false);

        wrapper.unmount();
    });
});
