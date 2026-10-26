import { mount } from '@vue/test-utils';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import AskUserQuestions from '@/views/SearchView/components/AskUser/AskUserQuestions.vue';

type AskUserQuestion = InstanceType<typeof AskUserQuestions>['$props']['questions'][number];

/**
 * The other AskUser files cover answering, skipping, the keyboard map and the
 * question's own content. What is left are the interactive states a mouse user
 * meets: the proximity hover indicator, focusing and blurring the free-text row,
 * the other-row submit affordance, and the disabled-option guards. Everything is
 * asserted through what is on screen or what the panel emits upward.
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

function lastAnswers(wrapper: ReturnType<typeof mountQuestions>) {
    const emitted = wrapper.emitted('update:answers');
    return emitted?.[emitted.length - 1]?.[0] as
        | Record<string, { selectedIds: string[]; otherText?: string; skipped?: boolean }>
        | undefined;
}

const singleQuestion: AskUserQuestion[] = [
    {
        id: 'q1',
        title: 'Pick one',
        options: [
            { id: 'a', title: 'Option A' },
            { id: 'b', title: 'Option B' },
        ],
        allowOther: false,
    },
];

describe('when the user hovers over the option rows', () => {
    it('user sees a hover highlight appear while the pointer is inside the list', async () => {
        const wrapper = mountQuestions(singleQuestion);
        const rows = wrapper.get('.ask-rows-extend');

        await rows.trigger('mouseenter');
        await rows.trigger('mousemove', { clientX: 10, clientY: 10 });
        await nextTick();
        await nextTick();

        // The proximity hover paints a moving highlight behind the row under the pointer.
        expect(wrapper.find('.bg-hover').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user sees the highlight disappear when the pointer leaves the list', async () => {
        const wrapper = mountQuestions(singleQuestion);
        const rows = wrapper.get('.ask-rows-extend');

        await rows.trigger('mouseenter');
        await rows.trigger('mousemove', { clientX: 10, clientY: 10 });
        await nextTick();
        await nextTick();
        expect(wrapper.find('.bg-hover').exists()).toBe(true);

        await rows.trigger('mouseleave');
        await nextTick();

        expect(wrapper.find('.bg-hover').exists()).toBe(false);

        wrapper.unmount();
    });
});

describe('when the free-text row is focused and empty', () => {
    it('user sees the input hint panel placed over the row', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');

        // The hint only shows for an empty, focused free-text row.
        await input.trigger('focus');
        await nextTick();
        await nextTick();

        expect(wrapper.find('[key="other-input"], .ring-border').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user stops seeing the hint once they start typing', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');

        await input.trigger('focus');
        await nextTick();
        await input.setValue('typed text');
        await nextTick();
        await nextTick();

        expect(lastAnswers(wrapper)?.q1?.otherText).toBe('typed text');

        wrapper.unmount();
    });

    it('user gets the free-text row marked as answered once it has text', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');

        await input.setValue('my own answer');
        await nextTick();

        const rows = wrapper.findAll('[data-proximity-index]');
        const otherRow = rows[rows.length - 1]!;
        expect(otherRow.attributes('data-state')).toBe('checked');

        wrapper.unmount();
    });
});

describe('when the user clicks the free-text row', () => {
    it('user gets the text input focused so they can type immediately', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const rows = wrapper.findAll('[data-proximity-index]');
        const otherRow = rows[rows.length - 1]!;

        await otherRow.trigger('click');
        await nextTick();

        expect(document.activeElement).toBe(wrapper.get('input[type="text"]').element);

        wrapper.unmount();
    });

    it('user gets the answer submitted when clicking the arrow on a filled free-text row', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');
        await input.setValue('submitted text');
        await nextTick();

        const rows = wrapper.findAll('[data-proximity-index]');
        const otherRow = rows[rows.length - 1]!;
        await otherRow.trigger('click');
        await nextTick();

        // A filled other-row shows an arrow that submits the free-text answer.
        const arrow = otherRow.find('[role="button"]');
        expect(arrow.exists()).toBe(true);
        await arrow.trigger('click');
        await nextTick();

        expect(wrapper.emitted('complete')).toBeTruthy();

        wrapper.unmount();
    });

    it('user gets no arrow on an empty free-text row', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const rows = wrapper.findAll('[data-proximity-index]');
        const otherRow = rows[rows.length - 1]!;
        await otherRow.trigger('click');
        await nextTick();

        expect(otherRow.find('[role="button"]').exists()).toBe(false);

        wrapper.unmount();
    });
});

describe('when the user submits free text with Enter', () => {
    it('user gets the typed answer submitted', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');
        await input.setValue('pressed enter');

        await input.trigger('keydown', { key: 'Enter' });
        await nextTick();

        expect(wrapper.emitted('complete')?.[0]?.[0]).toMatchObject({
            q1: { otherText: 'pressed enter' },
        });

        wrapper.unmount();
    });

    it('user gets nothing submitted for whitespace-only free text', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');
        await input.setValue('    ');

        await input.trigger('keydown', { key: 'Enter' });
        await nextTick();

        expect(wrapper.emitted('complete')).toBeUndefined();

        wrapper.unmount();
    });
});

describe('when an option is disabled', () => {
    it('user gets no answer when clicking a disabled option', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick one',
                options: [
                    { id: 'a', title: 'Option A', disabled: true },
                    { id: 'b', title: 'Option B' },
                ],
                allowOther: false,
            },
        ]);

        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await nextTick();

        expect(wrapper.emitted('update:answers')).toBeUndefined();

        wrapper.unmount();
    });

    it('user gets no toggle when clicking a disabled option in a multi-select question', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick any',
                multiSelect: true,
                options: [
                    { id: 'a', title: 'Option A', disabled: true },
                    { id: 'b', title: 'Option B' },
                ],
                allowOther: false,
            },
        ]);

        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await nextTick();

        expect(wrapper.emitted('update:answers')).toBeUndefined();

        wrapper.unmount();
    });

    it('user gets no answer from the number key for a disabled option', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Pick one',
                options: [
                    { id: 'a', title: 'Option A', disabled: true },
                    { id: 'b', title: 'Option B' },
                ],
                allowOther: false,
            },
        ]);

        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true })
        );
        await nextTick();

        expect(wrapper.emitted('update:answers')).toBeUndefined();

        wrapper.unmount();
    });
});

describe('when the user presses space or enter on a focused row', () => {
    it('user gets the option picked with the space bar', async () => {
        const wrapper = mountQuestions(singleQuestion);
        const row = wrapper.findAll('[data-proximity-index]')[0]!;

        await row.trigger('keydown', { key: ' ' });
        await nextTick();

        expect(lastAnswers(wrapper)?.q1?.selectedIds).toEqual(['a']);

        wrapper.unmount();
    });

    it('user gets the option picked with the enter key', async () => {
        const wrapper = mountQuestions(singleQuestion);
        const row = wrapper.findAll('[data-proximity-index]')[1]!;

        await row.trigger('keydown', { key: 'Enter' });
        await nextTick();

        expect(lastAnswers(wrapper)?.q1?.selectedIds).toEqual(['b']);

        wrapper.unmount();
    });

    it('user gets no second answer when the shortcut is combined with a modifier', async () => {
        const wrapper = mountQuestions(singleQuestion);
        const row = wrapper.findAll('[data-proximity-index]')[0]!;

        await row.trigger('keydown', { key: 'Enter', ctrlKey: true });
        await nextTick();

        // Ctrl+Enter is the multi-select shortcut, not a row activation.
        expect(wrapper.emitted('update:answers')).toBeUndefined();

        wrapper.unmount();
    });
});

describe('when the question has no id', () => {
    it('user gets the answer still stored against a generated id', async () => {
        const wrapper = mountQuestions([
            {
                title: 'No id question',
                options: [{ title: 'Option A' }, { title: 'Option B' }],
                allowOther: false,
            } as AskUserQuestion,
        ]);

        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await nextTick();

        // The panel still reports an answer keyed by the generated question id.
        const answers = lastAnswers(wrapper);
        expect(Object.keys(answers ?? {})).toEqual(['q-0']);
        expect(answers?.['q-0']?.selectedIds).toEqual(['o-0']);

        wrapper.unmount();
    });
});

describe('when the question has no options at all', () => {
    it('user gets the free-text row as the only choice', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Anything else?',
                options: [],
                allowOther: true,
            },
        ]);

        const rows = wrapper.findAll('[data-proximity-index]');
        expect(rows).toHaveLength(1);
        expect(wrapper.find('input[type="text"]').exists()).toBe(true);

        wrapper.unmount();
    });

    it('user gets no navigation crash when there are no rows', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Nothing to pick',
                options: [],
                allowOther: false,
            },
        ]);

        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        );
        await nextTick();

        expect(wrapper.text()).toContain('Nothing to pick');

        wrapper.unmount();
    });
});

describe('when the question cannot be skipped', () => {
    it('user sees no skip action for a mandatory question', () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Must answer',
                options: [{ id: 'a', title: 'Option A' }],
                skippable: false,
                allowOther: false,
            },
        ]);

        expect(wrapper.find('.ask-footer-x').exists()).toBe(false);

        wrapper.unmount();
    });

    it('user gets nothing skipped when pressing right on a mandatory question', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Must answer',
                options: [{ id: 'a', title: 'Option A' }],
                skippable: false,
                allowOther: false,
            },
        ]);

        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
        );
        await nextTick();

        expect(wrapper.emitted('skip')).toBeUndefined();

        wrapper.unmount();
    });
});

describe('when the user moves onto the free-text row with the keyboard', () => {
    it('user gets the text input focused when arrowing down to it', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);

        // From the only option, the next row is the free-text row.
        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        );
        await nextTick();
        document.body.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
        );
        await nextTick();

        expect(document.activeElement).toBe(wrapper.get('input[type="text"]').element);

        wrapper.unmount();
    });

    it('user gets the next row from the text field when arrowing down', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [
                    { id: 'a', title: 'Option A' },
                    { id: 'b', title: 'Option B' },
                ],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');

        await input.trigger('keydown', { key: 'ArrowDown' });
        await nextTick();

        // From the free-text row the next row wraps back to the first option.
        const rows = wrapper.findAll('[data-proximity-index]');
        expect(document.activeElement).toBe(rows[0]!.element);

        wrapper.unmount();
    });

    it('user gets no navigation while typing an ordinary character in the text field', async () => {
        const wrapper = mountQuestions([
            {
                id: 'q1',
                title: 'Describe it',
                options: [{ id: 'a', title: 'Option A' }],
                allowOther: true,
            },
        ]);
        const input = wrapper.get('input[type="text"]');
        (input.element as HTMLInputElement).focus();

        const event = new KeyboardEvent('keydown', {
            key: 'a',
            bubbles: true,
            cancelable: true,
        });
        input.element.dispatchEvent(event);
        await nextTick();

        // Ordinary typing must reach the input, not be swallowed by the row navigation.
        expect(event.defaultPrevented).toBe(false);

        wrapper.unmount();
    });
});
