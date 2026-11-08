import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, toRaw } from 'vue';

import { setLocale } from '@/i18n';
import type { SessionMessage } from '@/types/session';
import ConversationPanel from '@/views/SearchView/components/ConversationPanel/index.vue';

type OutputScrollBehavior = 'follow_output' | 'stay_position' | 'jump_to_top';

const settingsStoreMock = vi.hoisted(() => ({
    outputScrollBehavior: {
        value: 'follow_output',
    } as { value: OutputScrollBehavior },
    initialize: vi.fn().mockResolvedValue(undefined),
}));

const scrollerMock = vi.hoisted(() => ({
    focus: vi.fn(),
    getState: vi.fn(),
    getViewportElement: vi.fn(() => null),
    isAtEnd: vi.fn(),
    recalculate: vi.fn(),
    scrollBy: vi.fn(),
    scrollToEnd: vi.fn(),
    scrollToItem: vi.fn(),
}));

vi.mock('pinia', async (importOriginal) => {
    const actual = await importOriginal<typeof import('pinia')>();
    const { ref } = await import('vue');
    settingsStoreMock.outputScrollBehavior = ref(settingsStoreMock.outputScrollBehavior.value);
    return {
        ...actual,
        storeToRefs: () => ({
            outputScrollBehavior: settingsStoreMock.outputScrollBehavior,
        }),
    };
});

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => settingsStoreMock,
}));

vi.mock('@/components/ui/message-scroller', async () => {
    const { defineComponent, h } = await import('vue');
    return {
        MessageScroller: defineComponent({
            name: 'MessageScrollerStub',
            inheritAttrs: false,
            props: {
                items: {
                    type: Array,
                    default: () => [],
                },
            },
            emits: ['stateChange'],
            setup(_, { expose, slots }) {
                expose(scrollerMock);
                return () => h('div', { 'data-testid': 'message-scroller' }, slots.default?.());
            },
        }),
    };
});

const conversation: SessionMessage[] = [
    message('m1', 'user', 'How do I deploy this app?'),
    message('a1', 'assistant', 'Build it first.'),
    message('m2', 'user', 'And then?'),
];

function message(id: string, role: SessionMessage['role'], content: string): SessionMessage {
    return {
        id,
        role,
        content,
        parts: [],
        timestamp: 0,
    };
}

function mountPanel(messages: SessionMessage[] = conversation) {
    return mount(ConversationPanel, {
        props: {
            startDragging: vi.fn().mockResolvedValue(undefined),
            messages,
            isLoading: false,
            error: null,
            isPinned: false,
            historyOpen: false,
        },
        global: {
            stubs: {
                ConversationToolbar: true,
                MessageItem: true,
            },
        },
    });
}

beforeEach(() => {
    setLocale('en-US');
    settingsStoreMock.outputScrollBehavior.value = 'follow_output';
    settingsStoreMock.initialize.mockClear();
    scrollerMock.focus.mockReset();
    scrollerMock.getState.mockReset().mockReturnValue({
        atEnd: true,
        overflowing: false,
        following: true,
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
    });
    scrollerMock.isAtEnd.mockReset().mockReturnValue(true);
    scrollerMock.recalculate.mockReset();
    scrollerMock.scrollBy.mockReset();
    scrollerMock.scrollToEnd.mockReset();
    scrollerMock.scrollToItem.mockReset().mockReturnValue(true);
});

describe('user opens a conversation with the new message scroller', () => {
    it('user receives loading and completion announcements in the same region when compaction runs', async () => {
        const answer = message('a2', 'assistant', 'Working');
        const wrapper = mountPanel([...conversation, answer]);
        await flushPromises();
        const status = wrapper.get('[role="status"]');
        const region = status.element;
        expect(status.text()).toBe('');
        expect(status.attributes()).toMatchObject({
            'aria-live': 'polite',
            'aria-atomic': 'true',
        });
        expect(wrapper.get('[data-testid="message-scroller"]').element.contains(region)).toBe(
            false
        );

        await wrapper.setProps({
            isLoading: true,
            messages: [
                ...conversation,
                {
                    ...answer,
                    isStreaming: true,
                    parts: [{ id: 'c1', type: 'context_compaction', state: 'compacting' }],
                },
            ],
        });
        expect(wrapper.get('[role="status"]').element).toBe(region);
        expect(status.text()).toBe('Compacting context');
        expect(region.closest('[aria-busy="true"]')).toBeNull();

        const changes: MutationRecord[] = [];
        const observer = new MutationObserver((records) => changes.push(...records));
        observer.observe(region, { childList: true, characterData: true, subtree: true });
        await wrapper.setProps({ messages: structuredClone(toRaw(wrapper.props('messages'))) });
        await flushPromises();
        expect(changes).toHaveLength(0);
        observer.disconnect();

        await wrapper.setProps({
            isLoading: false,
            messages: [
                ...conversation,
                {
                    ...answer,
                    isStreaming: false,
                    parts: [{ id: 'c1', type: 'context_compaction', state: 'compacted' }],
                },
            ],
        });
        expect(wrapper.get('[role="status"]').element).toBe(region);
        expect(status.text()).toBe('Context compacted');
        setLocale('zh-CN');
        await nextTick();
        expect(status.text()).toBe('上下文已压缩');
        await wrapper.setProps({
            messages: [
                ...conversation,
                {
                    ...answer,
                    isStreaming: true,
                    parts: [
                        { id: 'c1', type: 'context_compaction', state: 'compacted' },
                        { id: 'c2', type: 'context_compaction', state: 'compacting' },
                    ],
                },
            ],
        });
        expect(status.text()).toBe('正在压缩上下文');
        wrapper.unmount();
    });

    it('user opens saved or replayed compaction markers without announcing historical completion', async () => {
        const saved: SessionMessage = {
            ...message('saved', 'assistant', 'Previous answer'),
            parts: [{ id: 'c1', type: 'context_compaction', state: 'compacted' }],
        };
        const wrapper = mountPanel([saved]);
        await flushPromises();
        expect(wrapper.get('[role="status"]').text()).toBe('');

        await wrapper.setProps({ messages: [{ ...saved, id: 'another-session' }] });
        expect(wrapper.get('[role="status"]').text()).toBe('');
        await wrapper.setProps({
            messages: [{ ...saved, id: 'resumed', isStreaming: true }],
            isLoading: true,
        });
        expect(wrapper.get('[role="status"]').text()).toBe('');
        wrapper.unmount();
    });

    it.each(['cancelled', 'failed'] as const)(
        'user does not receive a completion announcement when compaction is %s',
        async (outcome) => {
            const saved: SessionMessage = {
                ...message('a1', 'assistant', 'Earlier work'),
                parts: [{ id: 'old', type: 'context_compaction', state: 'compacted' }],
            };
            const wrapper = mountPanel([saved]);
            await flushPromises();
            const status = wrapper.get('[role="status"]');
            await wrapper.setProps({
                messages: [
                    {
                        ...saved,
                        isStreaming: true,
                        parts: [
                            ...saved.parts,
                            { id: 'pending', type: 'context_compaction', state: 'compacting' },
                        ],
                    },
                ],
            });
            expect(status.text()).toBe('Compacting context');
            await wrapper.setProps({
                messages: [{ ...saved, isStreaming: false, statusText: outcome }],
            });
            expect(status.text()).toBe('');
            wrapper.unmount();
        }
    );

    it('user opens an ongoing compaction after the empty announcement region has mounted', async () => {
        const wrapper = mountPanel([
            ...Array.from({ length: 12 }, (_, index) =>
                message(`history-${index}`, 'user', 'Earlier question')
            ),
            {
                ...message('running', 'assistant', ''),
                isStreaming: true,
                parts: [{ id: 'c1', type: 'context_compaction', state: 'compacting' }],
            },
        ]);
        const status = wrapper.get('[role="status"]');
        expect(status.text()).toBe('');
        await nextTick();
        expect(status.text()).toBe('Compacting context');
        await wrapper.setProps({
            messages: [
                {
                    ...message('another-session', 'assistant', ''),
                    parts: [{ id: 'c1', type: 'context_compaction', state: 'compacted' }],
                },
            ],
        });
        expect(status.text()).toBe('');
        wrapper.unmount();
    });

    it('user can preview each question and its reply from the navigation rail', async () => {
        const wrapper = mountPanel();
        await flushPromises();

        const scroller = wrapper.getComponent({ name: 'MessageScrollerStub' });
        expect(scroller.props('items')).toEqual([
            {
                id: 'm1',
                label: 'How do I deploy this app?',
                description: 'Build it first.',
                role: 'user',
                ariaLabel: 'Go to user message 1 of 2',
            },
            {
                id: 'm2',
                label: 'And then?',
                description: undefined,
                role: 'user',
                ariaLabel: 'Go to user message 2 of 2',
            },
        ]);
    });

    it('user gets a bounded preview from a long streamed reply', async () => {
        const wrapper = mountPanel([
            message('m1', 'user', 'Summarise this streamed response'),
            message('a1', 'assistant', 'word '.repeat(10_000)),
            message('a2', 'assistant', 'Second answer'),
        ]);
        await flushPromises();

        const scroller = wrapper.getComponent({ name: 'MessageScrollerStub' });
        const description = scroller.props('items')[0]?.description as string;

        expect(description.length).toBeLessThanOrEqual(320);
        expect(description).not.toContain('Second answer');
    });

    it('user starts at the latest output when follow mode is enabled', async () => {
        mountPanel();
        await flushPromises();

        expect(scrollerMock.scrollToEnd).toHaveBeenCalledWith('auto');
    });

    it('user is taken to their new question when jump-to-top is selected', async () => {
        settingsStoreMock.outputScrollBehavior.value = 'jump_to_top';
        const wrapper = mountPanel();
        await flushPromises();
        scrollerMock.scrollToItem.mockClear();

        await wrapper.setProps({
            messages: [...conversation, message('m3', 'user', 'What about rollback?')],
        });
        await nextTick();
        await flushPromises();

        expect(scrollerMock.scrollToItem).toHaveBeenCalledWith('m3', {
            align: 'start',
            offset: 12,
        });
    });

    it('user can return to the latest message after reading older output', async () => {
        const wrapper = mountPanel();
        await flushPromises();
        scrollerMock.isAtEnd.mockReturnValue(false);
        scrollerMock.getState.mockReturnValue({
            atEnd: false,
            overflowing: true,
            following: false,
            scrollTop: 100,
            scrollHeight: 1_000,
            clientHeight: 400,
        });

        wrapper.getComponent({ name: 'MessageScrollerStub' }).vm.$emit('stateChange', {
            atEnd: false,
            overflowing: true,
            following: false,
            scrollTop: 100,
            scrollHeight: 1_000,
            clientHeight: 400,
        });
        await nextTick();

        await wrapper.get('button[aria-label="Scroll to latest message"]').trigger('click');

        expect(scrollerMock.scrollToEnd).toHaveBeenCalledWith('smooth');
        expect(wrapper.emitted('latestContentVisibilityChange')).toContainEqual([false]);
    });
});
