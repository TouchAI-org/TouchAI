import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import ModelDropdownPopup from '@/views/SearchView/components/ModelDropdownPopup/index.vue';
import SessionHistoryPopover from '@/views/SearchView/components/SessionHistoryPopover/index.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: { props: ['name'], template: '<span />' },
}));
vi.mock('@components/ModelLogo.vue', () => ({
    default: { props: ['modelId', 'name', 'size'], template: '<span />' },
}));
vi.mock('@components/ModelCapabilityTags.vue', () => ({
    default: { props: ['model', 'size'], template: '<span />' },
}));
vi.mock('@services/EventService', () => ({
    AppEvent: {},
    eventService: { emit: vi.fn() },
}));
vi.mock('@services/NativeService', () => ({
    native: { window: { openSettingsWindow: vi.fn() } },
}));

const modelData = {
    toggleShortcut: 'Mod+M',
    activeModelId: '',
    activeProviderId: null,
    selectedModelId: '',
    selectedProviderId: null,
    searchQuery: '',
    models: [
        {
            id: 1,
            modelId: 'model-one',
            name: 'Model One',
            providerId: 1,
            providerName: 'Provider',
            reasoning: 0,
            tool_call: 0,
            modalities: null,
            attachment: 0,
            open_weights: 0,
        },
        {
            id: 2,
            modelId: 'model-two',
            name: 'Model Two',
            providerId: 1,
            providerName: 'Provider',
            reasoning: 0,
            tool_call: 0,
            modalities: null,
            attachment: 0,
            open_weights: 0,
        },
    ],
};

const historyData = {
    toggleShortcut: 'Mod+H',
    activeSessionId: null,
    searchQuery: '',
    isLoading: false,
    sessions: [
        {
            id: 1,
            session_id: 'session-1',
            title: 'First session',
            model: '',
            provider_id: null,
            message_count: 1,
            last_message_preview: 'First',
            last_message_at: null,
            status_badge_dismissed_turn_id: null,
            pending_terminal_status: null,
            pinned_at: null,
            archived_at: null,
            displayStatus: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
        },
        {
            id: 2,
            session_id: 'session-2',
            title: 'Second session',
            model: '',
            provider_id: null,
            message_count: 1,
            last_message_preview: 'Second',
            last_message_at: null,
            status_badge_dismissed_turn_id: null,
            pending_terminal_status: null,
            pinned_at: null,
            archived_at: null,
            displayStatus: null,
            created_at: '2026-01-02T00:00:00Z',
            updated_at: '2026-01-02T00:00:00Z',
        },
    ],
};

describe('Search overlay direct component contracts', () => {
    beforeEach(() => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        Element.prototype.scrollIntoView = vi.fn();
    });

    it('uses the shared elevated search surface for both overlay shells', () => {
        const modelWrapper = mount(ModelDropdownPopup, {
            props: {
                data: modelData,
            },
        });
        const historyWrapper = mount(SessionHistoryPopover, {
            props: {
                data: historyData,
            },
        });

        expect(modelWrapper.get('[data-model-dropdown-popover="true"]').classes()).toContain(
            'search-surface-elevated'
        );
        expect(historyWrapper.get('[data-search-history-popover="true"]').classes()).toContain(
            'search-surface-elevated'
        );

        modelWrapper.unmount();
        historyWrapper.unmount();
    });

    it('focuses model filtering and handles Arrow/Enter through direct callbacks', async () => {
        const onSearchQueryChange = vi.fn();
        const onModelSelect = vi.fn().mockResolvedValue(undefined);
        const wrapper = mount(ModelDropdownPopup, {
            attachTo: document.body,
            props: {
                data: modelData,
                onSearchQueryChange,
                onModelSelect,
            },
        });

        (wrapper.vm as unknown as { handleOverlayShown: () => void }).handleOverlayShown();
        expect(document.activeElement).toBe(wrapper.get('input').element);

        await wrapper.get('input').setValue('two');
        expect(onSearchQueryChange).toHaveBeenCalledWith('two');

        const handleKeyDown = (
            wrapper.vm as unknown as {
                handleKeyDown: (event: KeyboardEvent) => void;
            }
        ).handleKeyDown;
        handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
        await nextTick();
        expect(onModelSelect).toHaveBeenCalledWith(2);

        handleKeyDown(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true }));
        expect(wrapper.emitted('close')).toBeTruthy();
        wrapper.unmount();
    });

    it('focuses history filtering and handles Arrow/Enter through direct callbacks', async () => {
        const onSearchQueryChange = vi.fn();
        const onSessionOpen = vi.fn().mockResolvedValue(undefined);
        const wrapper = mount(SessionHistoryPopover, {
            attachTo: document.body,
            props: {
                data: historyData,
                onSearchQueryChange,
                onSessionOpen,
            },
        });

        (wrapper.vm as unknown as { handleOverlayShown: () => void }).handleOverlayShown();
        expect(document.activeElement).toBe(wrapper.get('input').element);

        await wrapper.get('input').setValue('second');
        expect(onSearchQueryChange).toHaveBeenCalledWith('second');

        const handleKeyDown = (
            wrapper.vm as unknown as {
                handleKeyDown: (event: KeyboardEvent) => void;
            }
        ).handleKeyDown;
        handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
        handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));
        await nextTick();
        expect(onSessionOpen).toHaveBeenCalled();

        handleKeyDown(new KeyboardEvent('keydown', { key: 'h', ctrlKey: true }));
        expect(wrapper.emitted('close')).toBeTruthy();
        wrapper.unmount();
    });
});
