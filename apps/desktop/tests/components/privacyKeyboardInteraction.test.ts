import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h, ref } from 'vue';

import type { SessionMessage } from '@/app/api/agent/history';
import type { PrivacyReviewAnnotation } from '@/app/api/privacy';
import PrivacyProtectionTooltip from '@/components/PrivacyProtectionTooltip.vue';
import { native } from '@/platform/native';
import {
    useSearchKeyboard,
    useSearchPageController,
} from '@/views/SearchView/composables/useSearchPage';

const annotation: PrivacyReviewAnnotation = {
    messageId: 41,
    textHash: 'a'.repeat(64),
    start: 0,
    end: 16,
    original: 'ada@example.test',
    placeholder: '{{EMAIL_0000000000000001}}',
    kind: 'email',
    rule: { id: 'email' },
};
const wrappers: ReturnType<typeof mount>[] = [];

function mountConversation(draft = '') {
    const sent: string[] = [];
    const query = ref(draft);
    const messages = ref<SessionMessage[]>([
        { id: 'user-41', role: 'user', content: annotation.original, parts: [], timestamp: 0 },
    ]);
    const Conversation = defineComponent({
        setup() {
            const quickSearchOpen = ref(false);
            const controller = useSearchPageController({
                searchBar: ref(undefined),
                quickSearchOpen,
                quickSearchPanel: ref(undefined),
                conversationPanel: ref(undefined),
            });
            useSearchKeyboard({
                viewReady: ref(true),
                queryText: query,
                attachments: ref([]),
                cursorContext: ref({
                    isMultiLine: false,
                    cursorAtStart: true,
                    cursorAtTextStart: true,
                    cursorAtEnd: true,
                }),
                modelOverride: ref({ modelId: null, providerId: null }),
                modelDropdownState: ref({ isOpen: false }),
                controller,
                sessionHistory: messages,
                pendingRequest: ref(null),
                isLoading: ref(false),
                pendingToolApproval: ref(null),
                approvePendingToolApproval: () => false,
                rejectPendingToolApproval: () => false,
                promptPendingToolApprovalAttention: () => {},
                getActiveOverlaySurface: () => null,
                isQuickSearchOpen: computed(() => quickSearchOpen.value),
                shouldTriggerQuickSearch: () => false,
                sessionHistoryOverlayOpen: ref(false),
                hideAllOverlays: async () => {},
                hideSearchWindow: native.window.hideSearchWindow,
                navigateInputHistory: () => 'ignored',
                closeModelDropdown: async () => {},
                toggleWindowMaximize: async () => {},
                handleSubmit: async (text) => {
                    sent.push(text);
                },
                clearAll: () => {
                    query.value = '';
                    messages.value = [];
                },
                cancelRequest: () => {},
                clearSession: () => {
                    messages.value = [];
                },
                clearDraft: () => {
                    query.value = '';
                },
            });
            return () =>
                h('main', [
                    h('div', { 'data-testid': 'transcript' }, [
                        messages.value.length
                            ? h(PrivacyProtectionTooltip, { annotation })
                            : 'Conversation closed',
                    ]),
                    h('input', { 'data-testid': 'draft-editor', value: query.value }),
                ]);
        },
    });
    const wrapper = mount(Conversation, { attachTo: document.body });
    wrappers.push(wrapper);
    return { wrapper, sent };
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount();
    document.body.innerHTML = '';
    setActivePinia(undefined);
});

async function waitForTooltip() {
    await vi.waitFor(() =>
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).not.toBeNull()
    );
}

describe('given the native conversation captures keyboard input before inline controls', () => {
    it('user dismisses focused privacy information then the tooltip closes without leaving the conversation', async () => {
        const { wrapper } = mountConversation();
        const trigger = wrapper.get('[data-testid="privacy-protected-text"]');
        (trigger.element as HTMLElement).focus();
        await waitForTooltip();

        await trigger.trigger('keydown', { key: 'Escape' });
        await flushPromises();

        expect(wrapper.get('[data-testid="transcript"]').text()).toBe(annotation.original);
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).toBeNull();
    });

    it.each(['Enter', ' '])(
        'user activates privacy information with %s then their draft is not sent',
        async (key) => {
            const { wrapper, sent } = mountConversation('Keep this unsent draft');
            const trigger = wrapper.get('[data-testid="privacy-protected-text"]');
            (trigger.element as HTMLElement).focus();
            await waitForTooltip();

            await trigger.trigger('keydown', { key });
            await flushPromises();

            expect(sent).toEqual([]);
            expect(
                wrapper.get<HTMLInputElement>('[data-testid="draft-editor"]').element.value
            ).toBe('Keep this unsent draft');
        }
    );

    it('user dismisses hovered privacy information while editing then their draft and conversation stay intact', async () => {
        const { wrapper } = mountConversation('Keep this unsent draft');
        const editor = wrapper.get<HTMLInputElement>('[data-testid="draft-editor"]');
        editor.element.focus();
        const trigger = wrapper.get('[data-testid="privacy-protected-text"]');
        await trigger.trigger('pointermove', { pointerType: 'mouse' });
        await waitForTooltip();

        await editor.trigger('keydown', { key: 'Escape' });
        await flushPromises();

        expect(editor.element.value).toBe('Keep this unsent draft');
        expect(wrapper.get('[data-testid="transcript"]').text()).toBe(annotation.original);
        expect(document.querySelector('[data-testid="privacy-protection-tooltip"]')).toBeNull();
    });
});
