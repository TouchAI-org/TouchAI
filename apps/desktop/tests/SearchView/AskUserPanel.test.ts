import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';
import type { AskUserQuestion } from '@/services/AgentService/contracts/tooling';
import { useAskUserStore } from '@/stores/askUser';
import AskUserPanel from '@/views/SearchView/components/AskUser/AskUserPanel.vue';

function createApprovalPayload(callId: string, overrides: Record<string, unknown> = {}) {
    return {
        callId,
        title: 'Run shell command',
        command: 'rm -rf build',
        approveLabel: 'Run',
        rejectLabel: 'Cancel',
        ...overrides,
    } as never;
}

const question = {
    question: 'Which environment should be deployed?',
    options: [{ label: 'Staging' }, { label: 'Production' }],
} as AskUserQuestion;

async function settle() {
    await nextTick();
    await nextTick();
    await nextTick();
}

/**
 * jsdom has no layout engine, so the panel's height observer has to be stubbed.
 * Height animation is not what these tests are about.
 */
function stubLayoutObservers() {
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe = vi.fn();
            unobserve = vi.fn();
            disconnect = vi.fn();
        }
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('when a tool needs the user to approve a command', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        setLocale('en-US');
        stubLayoutObservers();
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('user sees the command preview and both choices', async () => {
        const store = useAskUserStore();
        store.enqueueApproval(createApprovalPayload('call-1'), vi.fn());

        const wrapper = mount(AskUserPanel);
        await settle();

        expect(wrapper.text()).toContain('Run shell command');
        expect(wrapper.text()).toContain('rm -rf build');
        expect(wrapper.text()).toContain('Run');
        expect(wrapper.text()).toContain('Cancel');

        wrapper.unmount();
    });

    it('user cannot approve the command during the arming delay, only afterwards', async () => {
        vi.useFakeTimers();
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueApproval(
            createApprovalPayload('call-1', { keyboardApproveDelayMs: 450 }),
            resolve
        );

        const wrapper = mount(AskUserPanel);
        await settle();

        // A stray click in the first moments must not run the command.
        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await settle();
        expect(resolve).not.toHaveBeenCalled();
        expect(store.hasPending).toBe(true);

        vi.advanceTimersByTime(450);
        await settle();

        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await settle();
        expect(resolve).toHaveBeenCalledWith(true);

        wrapper.unmount();
    });

    it('user gets the command run when choosing to approve it', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueApproval(
            createApprovalPayload('call-1', { keyboardApproveDelayMs: 0 }),
            resolve
        );

        const wrapper = mount(AskUserPanel);
        await settle();

        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await settle();

        expect(resolve).toHaveBeenCalledWith(true);
        expect(store.hasPending).toBe(false);

        wrapper.unmount();
    });

    it('user gets the command stopped when choosing to reject it', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueApproval(
            createApprovalPayload('call-1', { keyboardApproveDelayMs: 0 }),
            resolve
        );

        const wrapper = mount(AskUserPanel);
        await settle();

        await wrapper.findAll('[data-proximity-index]')[1]!.trigger('click');
        await settle();

        expect(resolve).toHaveBeenCalledWith(false);

        wrapper.unmount();
    });

    it('user gets the command stopped when pressing Escape on the panel', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueApproval(
            createApprovalPayload('call-1', { keyboardApproveDelayMs: 0 }),
            resolve
        );

        const wrapper = mount(AskUserPanel);
        await settle();

        await wrapper.get('.ask-user-questions-root').trigger('keydown', { key: 'Escape' });
        await settle();

        expect(resolve).toHaveBeenCalledWith(false);

        wrapper.unmount();
    });
});

describe('when the app needs the user to confirm an action', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        setLocale('en-US');
        stubLayoutObservers();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the confirmation message and both choices', async () => {
        const store = useAskUserStore();
        store.enqueueConfirm(
            { title: 'Delete conversation', message: 'This cannot be undone.' },
            vi.fn()
        );

        const wrapper = mount(AskUserPanel);
        await settle();

        expect(wrapper.text()).toContain('Delete conversation');
        expect(wrapper.text()).toContain('This cannot be undone.');
        expect(wrapper.text()).toContain('Confirm');
        expect(wrapper.text()).toContain('Cancel');

        wrapper.unmount();
    });

    it('user gets the action confirmed when choosing the confirm option', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueConfirm({ message: 'Delete conversation?' }, resolve);

        const wrapper = mount(AskUserPanel);
        await settle();

        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await settle();

        expect(resolve).toHaveBeenCalledWith(true);

        wrapper.unmount();
    });

    it('user gets the action dropped when choosing cancel', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueConfirm({ message: 'Delete conversation?' }, resolve);

        const wrapper = mount(AskUserPanel);
        await settle();

        await wrapper.findAll('[data-proximity-index]')[1]!.trigger('click');
        await settle();

        expect(resolve).toHaveBeenCalledWith(false);

        wrapper.unmount();
    });
});

describe('when the assistant asks the user to choose between options', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        setLocale('en-US');
        stubLayoutObservers();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the question text and every option', async () => {
        const store = useAskUserStore();
        store.enqueueQuestion([question], vi.fn());

        const wrapper = mount(AskUserPanel);
        await settle();

        expect(wrapper.text()).toContain('Which environment should be deployed?');
        expect(wrapper.text()).toContain('Staging');
        expect(wrapper.text()).toContain('Production');

        wrapper.unmount();
    });

    it('user gets the picked option label reported back to the assistant', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueQuestion([question], resolve);

        const wrapper = mount(AskUserPanel);
        await settle();

        await wrapper.findAll('[data-proximity-index]')[1]!.trigger('click');
        await settle();

        expect(resolve).toHaveBeenCalledWith([
            {
                questionIndex: 0,
                selectedLabels: ['Production'],
                otherText: undefined,
                skipped: false,
            },
        ]);

        wrapper.unmount();
    });

    it('user gets a cancelled question reported as no answer', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueQuestion([question], resolve);

        const wrapper = mount(AskUserPanel);
        await settle();

        await wrapper.get('.ask-user-questions-root').trigger('keydown', { key: 'Escape' });
        await settle();

        expect(resolve).toHaveBeenCalledWith(null);

        wrapper.unmount();
    });
});

describe('when the user is asked several questions in a row', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        setLocale('en-US');
        stubLayoutObservers();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user gets every answer reported, with the skipped one marked as skipped', async () => {
        const store = useAskUserStore();
        const resolve = vi.fn();
        store.enqueueQuestion(
            [
                question,
                {
                    question: 'Should the deploy be announced?',
                    options: [{ label: 'Yes' }, { label: 'No' }],
                } as AskUserQuestion,
            ],
            resolve
        );

        const wrapper = mount(AskUserPanel);
        await settle();

        expect(wrapper.text()).toContain('1 / 2');

        // Answer the first question; the panel moves on to the second one.
        await wrapper.findAll('[data-proximity-index]')[0]!.trigger('click');
        await settle();

        expect(wrapper.text()).toContain('Should the deploy be announced?');
        expect(wrapper.text()).toContain('2 / 2');

        // Skip the second question.
        const skipButton = wrapper
            .findAll('button')
            .find((button) => button.text().startsWith('Skip'));
        expect(skipButton).toBeDefined();
        await skipButton!.trigger('click');
        await settle();

        expect(resolve).toHaveBeenCalledWith([
            {
                questionIndex: 0,
                selectedLabels: ['Staging'],
                otherText: undefined,
                skipped: false,
            },
            {
                questionIndex: 1,
                selectedLabels: [],
                skipped: true,
            },
        ]);

        wrapper.unmount();
    });
});
