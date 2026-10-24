import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import AskUserQuestions from '@/views/SearchView/components/AskUser/AskUserQuestions.vue';

type AskUserQuestion = InstanceType<typeof AskUserQuestions>['$props']['questions'][number];

/**
 * The free-text answer and the skip path are the two ways a user can answer without picking
 * a listed option. Both change what the model receives, so they are asserted through what
 * the panel reports upward rather than through its internal state.
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

const withOther: AskUserQuestion[] = [
    {
        id: 'q1',
        title: 'Which style?',
        options: [
            { id: 'a', title: 'Option A' },
            { id: 'b', title: 'Option B' },
        ],
        allowOther: true,
    },
];

const twoQuestions: AskUserQuestion[] = [
    {
        id: 'q1',
        title: 'First',
        options: [
            { id: 'a', title: 'Option A' },
            { id: 'b', title: 'Option B' },
        ],
        allowOther: false,
    },
    {
        id: 'q2',
        title: 'Second',
        options: [
            { id: 'x', title: 'Option X' },
            { id: 'y', title: 'Option Y' },
        ],
        allowOther: false,
    },
];

function mountQuestions(questions: AskUserQuestion[], overrides: Record<string, unknown> = {}) {
    return mount(AskUserQuestions, {
        props: { questions, ...overrides },
        attachTo: document.body,
    });
}

function lastAnswers(wrapper: ReturnType<typeof mountQuestions>) {
    const emitted = wrapper.emitted('update:answers');
    return emitted?.[emitted.length - 1]?.[0] as
        | Record<string, { selectedIds: string[]; otherText?: string; skipped?: boolean }>
        | undefined;
}

describe('user answers in their own words', () => {
    it('user gets the typed text carried in the answer', async () => {
        const wrapper = mountQuestions(withOther);

        await wrapper.find('input[type="text"]').setValue('a handwritten answer');

        expect(lastAnswers(wrapper)?.q1?.otherText).toBe('a handwritten answer');

        wrapper.unmount();
    });

    it('user gets the answers completed after submitting their own words on the last question', async () => {
        const wrapper = mountQuestions(withOther);

        const input = wrapper.find('input[type="text"]');
        await input.setValue('my own words');
        await input.trigger('keydown', { key: 'Enter' });

        const completed = wrapper.emitted('complete');
        expect(completed).toBeTruthy();
        const snapshot = completed![0]![0] as Record<string, { otherText?: string }>;
        expect(snapshot.q1?.otherText).toBe('my own words');

        wrapper.unmount();
    });

    it('user gets no answer recorded when the field holds only spaces', async () => {
        const wrapper = mountQuestions(withOther);

        const input = wrapper.find('input[type="text"]');
        await input.setValue('   ');
        await input.trigger('keydown', { key: 'Enter' });

        // A blank answer is not an answer, so nothing is submitted and nothing advances.
        expect(wrapper.emitted('update:currentIndex')).toBeUndefined();

        wrapper.unmount();
    });

    it('user gets the typed text trimmed when submitting', async () => {
        const wrapper = mountQuestions(withOther);

        const input = wrapper.find('input[type="text"]');
        await input.setValue('  padded  ');
        await input.trigger('keydown', { key: 'Enter' });

        expect(lastAnswers(wrapper)?.q1?.otherText).toBe('padded');

        wrapper.unmount();
    });
});

describe('user skips the question', () => {
    it('user gets the question reported as skipped rather than answered', async () => {
        const wrapper = mountQuestions(twoQuestions);

        const skip = wrapper.findAll('button').find((button) => /skip/i.test(button.text()));
        await skip!.trigger('click');

        expect(lastAnswers(wrapper)?.q1?.skipped).toBe(true);
        expect(wrapper.emitted('skip')?.[0]?.[0]).toBe('q1');

        wrapper.unmount();
    });

    it('user gets moved on to the next question after skipping', async () => {
        const wrapper = mountQuestions(twoQuestions);

        const skip = wrapper.findAll('button').find((button) => /skip/i.test(button.text()));
        await skip!.trigger('click');

        expect(wrapper.emitted('update:currentIndex')?.length).toBeGreaterThan(0);

        wrapper.unmount();
    });

    it('user gets the answers completed when skipping the last question', async () => {
        const wrapper = mountQuestions(twoQuestions, { currentIndex: 1 });

        const skip = wrapper.findAll('button').find((button) => /skip/i.test(button.text()));
        await skip!.trigger('click');

        expect(wrapper.emitted('complete')).toBeTruthy();

        wrapper.unmount();
    });
});

describe('user continues after choosing several options', () => {
    const multi: AskUserQuestion[] = [
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
    ];

    it('user gets the picked options reported when continuing', async () => {
        const wrapper = mountQuestions(multi);

        await wrapper.findAll('[role="checkbox"]')[0]!.trigger('click');
        const next = wrapper
            .findAll('button')
            .find((button) => /continue|finish|next|done/i.test(button.text()));
        expect(next).toBeTruthy();
        await next!.trigger('click');

        const completed = wrapper.emitted('complete');
        expect(completed).toBeTruthy();
        const snapshot = completed![0]![0] as Record<string, { selectedIds: string[] }>;
        expect(snapshot.q1?.selectedIds).toEqual(['a']);

        wrapper.unmount();
    });
});

describe('user answers a question with a controlled index', () => {
    it('user gets the question the parent selected', () => {
        const wrapper = mountQuestions(twoQuestions, { currentIndex: 1 });

        expect(wrapper.text()).toContain('Second');
        expect(wrapper.text()).not.toContain('First');

        wrapper.unmount();
    });

    it('user gets the index change reported instead of decided locally', async () => {
        const wrapper = mountQuestions(twoQuestions, { currentIndex: 0 });

        await wrapper.findAll('[role="radio"]')[0]!.trigger('click');

        expect(wrapper.emitted('update:currentIndex')?.[0]?.[0]).toBe(1);

        wrapper.unmount();
    });

    it('user gets the answers from the parent shown as already chosen', () => {
        const wrapper = mountQuestions(twoQuestions, {
            answers: { q1: { questionId: 'q1', selectedIds: ['b'], skipped: false } },
        });

        const checked = wrapper
            .findAll('[role="radio"]')
            .filter((row) => row.attributes('data-state') === 'checked');
        expect(checked).toHaveLength(1);

        wrapper.unmount();
    });
});
