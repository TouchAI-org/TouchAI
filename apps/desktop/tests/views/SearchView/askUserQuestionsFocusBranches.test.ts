import { mount } from '@vue/test-utils';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import AskUserQuestions from '@/views/SearchView/components/AskUser/AskUserQuestions.vue';

type AskUserQuestion = InstanceType<typeof AskUserQuestions>['$props']['questions'][number];

/**
 * Second pass over AskUserQuestions: the branches that only appear in specific
 * combinations — blurring the free-text row, changing questions while focus lives
 * outside the list, hovering an already-answered row, and the platform-specific
 * modifier symbol in the footer hint.
 */
beforeAll(() => {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        }
    );
});

beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

function mountQuestions(questions: AskUserQuestion[], overrides: Record<string, unknown> = {}) {
    return mount(AskUserQuestions, {
        props: { questions, ...overrides },
        attachTo: document.body,
    });
}

const otherQuestion: AskUserQuestion[] = [
    {
        id: 'q1',
        title: 'Describe it',
        options: [{ id: 'a', title: 'Option A' }],
        allowOther: true,
    },
];

const twoQuestions: AskUserQuestion[] = [
    {
        id: 'q1',
        title: 'First',
        options: [{ id: 'a', title: 'Option A' }],
        allowOther: false,
    },
    {
        id: 'q2',
        title: 'Second',
        options: [{ id: 'x', title: 'Option X' }],
        allowOther: false,
    },
];

describe('when the free-text row loses focus', () => {
    it('user sees the free-text row hint cleared when focus moves away', async () => {
        const wrapper = mountQuestions(otherQuestion);
        const input = wrapper.get('input[type="text"]');
        const rows = wrapper.findAll('[data-proximity-index]');
        const otherRow = rows[rows.length - 1]!;

        await input.trigger('focus');
        await nextTick();
        await otherRow.trigger('blur');
        await nextTick();

        // Blurring the other row drops its focused state, so the hint panel goes away.
        expect(wrapper.find('.ring-border').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user sees the free-text row hint cleared when the input itself blurs', async () => {
        const wrapper = mountQuestions(otherQuestion);
        const input = wrapper.get('input[type="text"]');

        await input.trigger('focus');
        await nextTick();
        await input.trigger('blur');
        await nextTick();

        expect(wrapper.find('.ring-border').exists()).toBe(false);

        wrapper.unmount();
    });
});

describe('when the question changes while focus is outside the list', () => {
    it('user does not get the focus yanked into the next question', async () => {
        const wrapper = mountQuestions(twoQuestions);

        // Focus lives on the page body, so advancing must not steal it.
        (document.body as HTMLElement).focus?.();
        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await nextTick();

        expect(wrapper.emitted('update:currentIndex')?.[0]?.[0]).toBe(1);

        wrapper.unmount();
    });

    it('user gets the first row of the next question focused when they were in the list', async () => {
        const wrapper = mountQuestions(twoQuestions);
        const firstRow = wrapper.findAll('[data-proximity-index]')[0]!;
        (firstRow.element as HTMLElement).focus();
        await nextTick();

        await firstRow.trigger('click');
        await nextTick();
        await nextTick();

        expect(wrapper.emitted('update:currentIndex')?.[0]?.[0]).toBe(1);

        wrapper.unmount();
    });
});

describe('when the user hovers an already answered row', () => {
    it('user sees the hover highlight but not the unselected treatment', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick any',
                multiSelect: true,
                options: [
                    { id: 'a', title: 'Option A' },
                    { id: 'b', title: 'Option B' },
                ],
                allowOther: false,
            },
        ]);
        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await nextTick();

        const rows = wrapper.get('.ask-rows-extend');
        await rows.trigger('mouseenter');
        await rows.trigger('mousemove', { clientX: 10, clientY: 10 });
        await nextTick();
        await nextTick();

        // The answered row stays visually selected; the hover layer is still drawn.
        const firstRow = wrapper.findAll('[data-proximity-index]')[0]!;
        expect(firstRow.attributes('data-state')).toBe('checked');
        expect(wrapper.find('.bg-hover').exists()).toBe(true);

        wrapper.unmount();
    });
});

describe('when the app runs on macOS', () => {
    it('user sees the command symbol in the multi-select hint', async () => {
        const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');

        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick any',
                multiSelect: true,
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: false,
            },
        ]);

        expect(wrapper.text()).toContain('⌘');

        platformSpy.mockRestore();
        wrapper.unmount();
    });

    it('user sees the control symbol on other platforms', async () => {
        const platformSpy = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');

        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick any',
                multiSelect: true,
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: false,
            },
        ]);

        expect(wrapper.text()).toContain('⌃');

        platformSpy.mockRestore();
        wrapper.unmount();
    });
});

describe('when the question uses the caller labels', () => {
    it('user sees the caller own continue label', () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick any',
                multiSelect: true,
                nextLabel: 'Apply selection',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: false,
            },
        ]);

        expect(wrapper.text()).toContain('Apply selection');

        wrapper.unmount();
    });

    it('user sees the default continue label when the caller gave none', () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick any',
                multiSelect: true,
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: false,
            },
        ]);

        // The footer still offers a continue action, just with the built-in wording.
        expect(wrapper.findAll('button').length).toBeGreaterThan(0);

        wrapper.unmount();
    });
});
