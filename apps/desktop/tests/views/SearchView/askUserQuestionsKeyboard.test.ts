import { mount } from '@vue/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import AskUserQuestions from '@/views/SearchView/components/AskUser/AskUserQuestions.vue';

type AskUserQuestion = InstanceType<typeof AskUserQuestions>['$props']['questions'][number];

/**
 * The three existing AskUser files cover answering, the free-text answer and skip.
 * What is left is how a keyboard user moves through the panel and how the question
 * itself is presented: number keys, arrow keys, Home/End, the question counter and
 * the optional subtitle, command preview and stacked layout. All of it is asserted
 * through what is on screen or what the panel reports upward.
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

const twoQuestions: AskUserQuestion[] = [
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

function pressOnBody(init: KeyboardEventInit) {
    document.body.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    );
}

function lastAnswers(wrapper: ReturnType<typeof mountQuestions>) {
    const emitted = wrapper.emitted('update:answers');
    return emitted?.[emitted.length - 1]?.[0] as
        | Record<string, { selectedIds: string[]; otherText?: string }>
        | undefined;
}

describe('user answers with the number keys', () => {
    it('user gets the option matching the pressed number picked', async () => {
        const wrapper = mountQuestions(twoQuestions);

        pressOnBody({ key: '2' });
        await wrapper.vm.$nextTick();

        expect(lastAnswers(wrapper)?.q1?.selectedIds).toEqual(['b']);

        wrapper.unmount();
    });

    it('user gets no answer when the pressed number has no option behind it', async () => {
        const wrapper = mountQuestions(twoQuestions);

        pressOnBody({ key: '5' });
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('update:answers')).toBeUndefined();

        wrapper.unmount();
    });

    it('user gets the free-text field focused when pressing the number after the last option', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Which style?',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');

        pressOnBody({ key: '2' });
        await wrapper.vm.$nextTick();

        expect(document.activeElement).toBe(input.element);

        wrapper.unmount();
    });

    it('user typing a digit into the free-text field does not pick an option', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Which style?',
                options: [
                    { id: 'a', title: 'Option A' },
                    { id: 'b', title: 'Option B' },
                ],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');

        input.element.dispatchEvent(
            new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true })
        );
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('update:answers')).toBeUndefined();

        wrapper.unmount();
    });
});

describe('user moves through the options with the arrow keys', () => {
    it('user gets the first option focused when pressing the down arrow', async () => {
        const wrapper = mountQuestions(twoQuestions);

        pressOnBody({ key: 'ArrowDown' });
        await wrapper.vm.$nextTick();

        const rows = wrapper.findAll('[data-proximity-index]');
        expect(document.activeElement).toBe(rows[0]!.element);

        wrapper.unmount();
    });

    it('user gets the last option focused when pressing the end key', async () => {
        const wrapper = mountQuestions(twoQuestions);

        pressOnBody({ key: 'End' });
        await wrapper.vm.$nextTick();

        const rows = wrapper.findAll('[data-proximity-index]');
        expect(document.activeElement).toBe(rows[rows.length - 1]!.element);

        wrapper.unmount();
    });

    it('user gets the first option focused again when pressing home', async () => {
        const wrapper = mountQuestions(twoQuestions);

        pressOnBody({ key: 'End' });
        await wrapper.vm.$nextTick();
        pressOnBody({ key: 'Home' });
        await wrapper.vm.$nextTick();

        const rows = wrapper.findAll('[data-proximity-index]');
        expect(document.activeElement).toBe(rows[0]!.element);

        wrapper.unmount();
    });

    it('user wraps back to the last option when pressing up on the first', async () => {
        const wrapper = mountQuestions(twoQuestions);

        pressOnBody({ key: 'ArrowDown' });
        await wrapper.vm.$nextTick();
        pressOnBody({ key: 'ArrowUp' });
        await wrapper.vm.$nextTick();

        const rows = wrapper.findAll('[data-proximity-index]');
        expect(document.activeElement).toBe(rows[rows.length - 1]!.element);

        wrapper.unmount();
    });

    it('user gets the previous question back when pressing left', async () => {
        const wrapper = mountQuestions(twoQuestions, { currentIndex: 1 });

        pressOnBody({ key: 'ArrowLeft' });
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('update:currentIndex')?.[0]?.[0]).toBe(0);

        wrapper.unmount();
    });

    it('user gets nothing to go back to on the first question', async () => {
        const wrapper = mountQuestions(twoQuestions);

        pressOnBody({ key: 'ArrowLeft' });
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('update:currentIndex')).toBeUndefined();

        wrapper.unmount();
    });

    it('user gets the question skipped when pressing right', async () => {
        const wrapper = mountQuestions(twoQuestions);

        pressOnBody({ key: 'ArrowRight' });
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('skip')?.[0]?.[0]).toBe('q1');

        wrapper.unmount();
    });
});

describe('user reads a question with extra context', () => {
    it('user sees how far through the questions they are', () => {
        const wrapper = mountQuestions(twoQuestions);

        expect(wrapper.text()).toContain('1 / 2');

        wrapper.unmount();
    });

    it('user sees the counter and the back action once past the first question', () => {
        const wrapper = mountQuestions(twoQuestions, { currentIndex: 1 });

        expect(wrapper.text()).toContain('2 / 2');
        const back = wrapper.findAll('button').find((button) => /back|返回/i.test(button.text()));
        expect(back).toBeTruthy();

        wrapper.unmount();
    });

    it('user sees the question explanation and command preview', () => {
        const wrapper = mountQuestions([
            {
                ...twoQuestions[0]!,
                subtitle: 'This runs a shell command',
                commandPreview: 'pnpm build --watch',
            },
        ]);

        expect(wrapper.text()).toContain('This runs a shell command');
        expect(wrapper.get('pre').text()).toBe('pnpm build --watch');

        wrapper.unmount();
    });

    it('user sees an option description under its title in the stacked layout', () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick a target',
                layout: 'stacked' as const,
                options: [
                    { id: 'a', title: 'Option A', description: 'Builds everything' },
                    { id: 'b', title: 'Option B', description: 'Builds one package' },
                ],
                allowOther: false,
            },
        ]);

        expect(wrapper.text()).toContain('Builds everything');
        expect(wrapper.text()).toContain('Builds one package');

        wrapper.unmount();
    });

    it('user sees the caller’s own label for skipping', () => {
        const wrapper = mountQuestions(twoQuestions, { skipLabel: 'Not now' });

        expect(wrapper.text()).toContain('Not now');

        wrapper.unmount();
    });
});

describe('user finishes a question that takes several options', () => {
    const multi: AskUserQuestion[] = [
        {
            id: 'q1',
            title: 'Pick any',
            multiSelect: true,
            nextLabel: 'Use these',
            options: [
                { id: 'a', title: 'Option A' },
                { id: 'b', title: 'Option B' },
            ],
            allowOther: false,
        },
    ];

    it('user sees the continue action disabled until something is picked', async () => {
        const wrapper = mountQuestions(multi);
        const next = () =>
            wrapper.findAll('button').find((button) => button.text().includes('Use these'))!;

        expect(next().attributes('disabled')).toBeDefined();

        await wrapper.findAll('[role="checkbox"]')[0]!.trigger('click');

        expect(next().attributes('disabled')).toBeUndefined();

        wrapper.unmount();
    });

    it('user gets the answers completed with the keyboard shortcut', async () => {
        const wrapper = mountQuestions(multi);

        await wrapper.findAll('[role="checkbox"]')[1]!.trigger('click');
        await wrapper
            .get('.ask-user-questions-root')
            .trigger('keydown', { key: 'Enter', ctrlKey: true });

        const completed = wrapper.emitted('complete');
        expect(completed).toBeTruthy();
        expect(
            (completed![0]![0] as Record<string, { selectedIds: string[] }>).q1?.selectedIds
        ).toEqual(['b']);

        wrapper.unmount();
    });

    it('user gets nothing completed by the shortcut while nothing is picked', async () => {
        const wrapper = mountQuestions(multi);

        await wrapper
            .get('.ask-user-questions-root')
            .trigger('keydown', { key: 'Enter', ctrlKey: true });

        expect(wrapper.emitted('complete')).toBeUndefined();

        wrapper.unmount();
    });
});
