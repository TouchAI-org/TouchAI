import { enableAutoUnmount, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';

import { provideMotionPreferences } from '@/composables/useMotion';
import AssistantMessage from '@/views/SearchView/components/ConversationPanel/components/AssistantMessage.vue';
import BuiltInBashToolCallItem from '@/views/SearchView/components/ConversationPanel/components/BuiltInBashToolCallItem.vue';
import ReasoningBlock from '@/views/SearchView/components/ConversationPanel/components/ReasoningBlock.vue';

vi.mock('@/stores/askUser', () => ({ useAskUserStore: () => ({ current: null }) }));
vi.mock('@/components/MarkdownContent.vue', () => ({
    default: { props: ['content'], template: '<div>{{ content }}</div>' },
}));
enableAutoUnmount(afterEach);
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe.each(['tips', 'reasoning', 'bash'] as const)('user views streaming %s', (kind) => {
    it('user hiding the native window stops display timers even if WebView stays visible', async () => {
        vi.useFakeTimers();
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        let policy!: ReturnType<typeof provideMotionPreferences>;
        const wrapper = mount(
            defineComponent({
                setup() {
                    policy = provideMotionPreferences(ref('standard'), ref(false));
                    return () => {
                        if (kind === 'tips') {
                            return h(AssistantMessage, {
                                message: {
                                    id: 'streaming',
                                    role: 'assistant',
                                    content: '',
                                    parts: [],
                                    timestamp: Date.now(),
                                    isStreaming: true,
                                },
                            });
                        }
                        if (kind === 'reasoning') {
                            return h(ReasoningBlock, {
                                content: 'Thinking',
                                isStreaming: true,
                                startedAt: Date.now(),
                            });
                        }
                        return h(BuiltInBashToolCallItem, {
                            verbText: 'Running',
                            summaryText: 'echo hello',
                            toolCall: {
                                id: 'bash',
                                name: 'Bash',
                                namespacedName: 'builtin__bash',
                                source: 'builtin',
                                arguments: { command: 'echo hello' },
                                status: 'executing',
                                startedAt: Date.now(),
                            },
                        });
                    };
                },
            }),
            {
                global: {
                    stubs: { AppIcon: true, MotionCollapse: { template: '<div><slot /></div>' } },
                },
            }
        );
        await vi.advanceTimersByTimeAsync(50);
        expect(vi.getTimerCount()).toBe(1);
        policy.setWindowVisible(false);
        await nextTick();
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(30_000);
        policy.setWindowVisible(true);
        await nextTick();
        expect(vi.getTimerCount()).toBe(1);
        if (kind !== 'tips') expect(wrapper.text()).toContain('30s');
        wrapper.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
