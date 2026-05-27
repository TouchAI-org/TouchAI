import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h, nextTick } from 'vue';

import type { SessionMessage } from '@/types/session';
import ConversationPanel from '@/views/SearchView/components/ConversationPanel/index.vue';

const settingsStoreMock = vi.hoisted(() => ({
    initialize: vi.fn(),
}));

const resizeObserverMock = vi.hoisted(() => ({
    callbacks: new Map<Element, ResizeObserverCallback>(),
    reset() {
        this.callbacks.clear();
    },
    emit(target: Element) {
        const callback = this.callbacks.get(target);
        callback?.([{ target } as ResizeObserverEntry], {} as ResizeObserver);
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

vi.mock('@/stores/settings', async () => {
    const { ref } = await import('vue');

    return {
        useSettingsStore: vi.fn(() => ({
            outputScrollBehavior: ref('stay_position'),
            initialize: settingsStoreMock.initialize,
        })),
    };
});

class ResizeObserverMock {
    private readonly callback: ResizeObserverCallback;
    private readonly targets = new Set<Element>();

    constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
    }

    observe(target: Element) {
        this.targets.add(target);
        resizeObserverMock.callbacks.set(target, this.callback);
    }

    disconnect() {
        for (const target of this.targets) {
            resizeObserverMock.callbacks.delete(target);
        }
        this.targets.clear();
    }
}

function createUserMessage(id: string, content: string): SessionMessage {
    return {
        id,
        role: 'user',
        content,
        parts: [],
        timestamp: Date.now(),
    };
}

function setElementMetrics(
    element: HTMLElement,
    metrics: {
        clientHeight: number;
        scrollHeight: number;
        scrollTop: number;
    }
) {
    let scrollTop = metrics.scrollTop;

    Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        get: () => metrics.clientHeight,
    });
    Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        get: () => metrics.scrollHeight,
    });
    Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });
}

async function flushPanelWork() {
    await flushPromises();
    await nextTick();
    await Promise.resolve();
}

describe('ConversationPanel resize metrics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resizeObserverMock.reset();
        settingsStoreMock.initialize.mockResolvedValue(undefined);
        vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        document.body.innerHTML = '';
    });

    it('refreshes timeline height metrics when the conversation viewport is resized without scrolling', async () => {
        const wrapper = mount(ConversationPanel, {
            attachTo: document.body,
            props: {
                messages: [
                    createUserMessage('user-1', 'first prompt'),
                    createUserMessage('user-2', 'second prompt'),
                ],
                isLoading: false,
                error: null,
                isPinned: false,
                fillAvailableHeight: true,
                historyOpen: false,
                maxHeight: 240,
            },
            global: {
                stubs: {
                    ConversationToolbar: {
                        name: 'ConversationToolbar',
                        setup(_, { expose }) {
                            expose({ getHistoryAnchor: () => null });
                            return () => h('div', { 'data-testid': 'conversation-toolbar' });
                        },
                    },
                    MessageItem: {
                        name: 'MessageItem',
                        props: ['message'],
                        template: '<div data-testid="message-item" />',
                    },
                    ConversationTimeline: {
                        name: 'ConversationTimeline',
                        props: [
                            'messages',
                            'containerHeight',
                            'scrollTop',
                            'scrollHeight',
                            'clientHeight',
                        ],
                        template:
                            '<div data-testid="timeline" :data-container-height="containerHeight" :data-client-height="clientHeight" :data-scroll-height="scrollHeight" />',
                    },
                },
            },
        });

        await flushPanelWork();

        const container = wrapper.get('.conversation-container').element as HTMLElement;
        setElementMetrics(container, {
            clientHeight: 240,
            scrollHeight: 960,
            scrollTop: 120,
        });
        await wrapper.get('.conversation-container').trigger('scroll');
        await nextTick();

        expect(wrapper.get('[data-testid="timeline"]').attributes('data-container-height')).toBe(
            '240'
        );
        expect(wrapper.get('[data-testid="timeline"]').attributes('data-client-height')).toBe(
            '240'
        );

        setElementMetrics(container, {
            clientHeight: 360,
            scrollHeight: 960,
            scrollTop: 120,
        });
        resizeObserverMock.emit(container);
        await flushPanelWork();

        expect(wrapper.get('[data-testid="timeline"]').attributes('data-container-height')).toBe(
            '360'
        );
        expect(wrapper.get('[data-testid="timeline"]').attributes('data-client-height')).toBe(
            '360'
        );
        expect(wrapper.get('[data-testid="timeline"]').attributes('data-scroll-height')).toBe(
            '960'
        );

        wrapper.unmount();
    });
});
