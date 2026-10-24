import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import AskUserQuestions from '@/views/SearchView/components/AskUser/AskUserQuestions.vue';

type AskUserQuestion = InstanceType<typeof AskUserQuestions>['$props']['questions'][number];

/**
 * The panel asks the model's questions one at a time and reports answers upward. The
 * behavior worth pinning down is what the user can do: pick a single option and move on,
 * toggle several, skip when allowed, and finish on the last question.
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

const singleQuestion = [
    {
        id: 'q1',
        title: 'Pick one',
        options: [
            { id: 'a', title: 'Option A' },
            { id: 'b', title: 'Option B' },
            { id: 'c', title: 'Option C', disabled: true },
        ],
        allowOther: false,
    },
];

const twoQuestions = [
    {
        id: 'q1',
        title: 'First question',
        options: [
            { id: 'a', title: 'Option A' },
            { id: 'b', title: 'Option B' },
        ],
        allowOther: false,
    },
    {
        id: 'q2',
        title: 'Second question',
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

function latestAnswers(wrapper: ReturnType<typeof mountQuestions>) {
    const emitted = wrapper.emitted('update:answers');
    return emitted?.[emitted.length - 1]?.[0] as
        | Record<string, { selectedIds: string[]; skipped?: boolean }>
        | undefined;
}

describe('user answers a question that takes one option', () => {
    it('user gets the picked option recorded', async () => {
        const wrapper = mountQuestions(singleQuestion);

        await wrapper.findAll('[role="radio"]')[1]!.trigger('click');

        expect(latestAnswers(wrapper)?.q1?.selectedIds).toEqual(['b']);

        wrapper.unmount();
    });

    it('user gets a disabled option ignored', async () => {
        const wrapper = mountQuestions(singleQuestion);

        await wrapper.findAll('[role="radio"]')[2]!.trigger('click');

        // Nothing was answered, so no update was reported at all.
        expect(wrapper.emitted('update:answers')).toBeUndefined();

        wrapper.unmount();
    });

    it('user gets sent to the next question after answering the first', async () => {
        const wrapper = mountQuestions(twoQuestions);

        await wrapper.findAll('[role="radio"]')[0]!.trigger('click');

        const emitted = wrapper.emitted('update:currentIndex')!;
        expect(emitted[emitted.length - 1]?.[0]).toBe(1);

        wrapper.unmount();
    });

    it('user gets the answers completed after answering the last question', async () => {
        const wrapper = mountQuestions(twoQuestions, { currentIndex: 1 });

        await wrapper.findAll('[role="radio"]')[0]!.trigger('click');

        const completed = wrapper.emitted('complete');
        expect(completed).toBeTruthy();
        const snapshot = completed![0]![0] as Record<string, { selectedIds: string[] }>;
        expect(snapshot.q2?.selectedIds).toEqual(['x']);

        wrapper.unmount();
    });
});

describe('user answers a question that takes several options', () => {
    const multi = [
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

    it('user gets each toggled option added to the answer', async () => {
        const wrapper = mountQuestions(multi);

        await wrapper.findAll('[role="checkbox"]')[0]!.trigger('click');
        await wrapper.findAll('[role="checkbox"]')[1]!.trigger('click');

        expect(latestAnswers(wrapper)?.q1?.selectedIds).toEqual(['a', 'b']);

        wrapper.unmount();
    });

    it('user gets an option removed when toggling it off again', async () => {
        const wrapper = mountQuestions(multi);

        await wrapper.findAll('[role="checkbox"]')[0]!.trigger('click');
        await wrapper.findAll('[role="checkbox"]')[0]!.trigger('click');

        expect(latestAnswers(wrapper)?.q1?.selectedIds).toEqual([]);

        wrapper.unmount();
    });
});

describe('user skips a question they do not want to answer', () => {
    it('user gets the question reported as skipped', async () => {
        const wrapper = mountQuestions(twoQuestions);

        const skip = wrapper.findAll('button').find((button) => /skip/i.test(button.text()));
        expect(skip).toBeTruthy();
        await skip!.trigger('click');

        expect(wrapper.emitted('skip')).toBeTruthy();

        wrapper.unmount();
    });

    it('user gets no skip action when the question forbids it', () => {
        const wrapper = mountQuestions([{ ...twoQuestions[0]!, skippable: false }]);

        const skip = wrapper.findAll('button').find((button) => /skip/i.test(button.text()));
        expect(skip).toBeUndefined();

        wrapper.unmount();
    });
});

describe('user closes the questions without answering', () => {
    it('user gets a cancel reported when pressing Escape', async () => {
        const wrapper = mountQuestions(twoQuestions);

        await wrapper.find('.ask-user-questions-root').trigger('keydown', { key: 'Escape' });

        expect(wrapper.emitted('cancel')).toBeTruthy();

        wrapper.unmount();
    });
});
