import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import ModelDropdownPopup from '@/views/PopupView/components/ModelDropdownPopup/index.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/ModelLogo.vue', () => ({
    default: {
        name: 'ModelLogo',
        props: ['modelId', 'name', 'size'],
        template: '<span data-testid="model-logo">{{ name }}</span>',
    },
}));

vi.mock('@components/ModelCapabilityTags.vue', () => ({
    default: {
        name: 'ModelCapabilityTags',
        props: ['model', 'size'],
        template: '<span data-testid="capability-tags" />',
    },
}));

vi.mock('@services/EventService', () => ({
    AppEvent: {
        POPUP_MODEL_SELECT: 'popup-model-select',
        POPUP_MODEL_SEARCH_QUERY_CHANGE: 'popup-model-search-query-change',
    },
    eventService: {
        emit: vi.fn(),
    },
}));

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            openSettingsWindow: vi.fn(),
        },
    },
}));

describe('ModelDropdownPopup i18n', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('renders search placeholder and model badges in English without truncating badge text', () => {
        setLocale('en-US');

        const wrapper = mount(ModelDropdownPopup, {
            props: {
                data: {
                    activeModelId: 'gpt-4o',
                    activeProviderId: 1,
                    selectedModelId: 'gpt-4o',
                    selectedProviderId: 1,
                    searchQuery: '',
                    models: [
                        {
                            id: 10,
                            modelId: 'gpt-4o',
                            name: 'GPT-4o',
                            providerId: 1,
                            providerName: 'OpenAI',
                            reasoning: 0,
                            tool_call: 1,
                            modalities: null,
                            attachment: 1,
                            open_weights: 0,
                        },
                    ],
                },
                isInPopup: true,
                popupIdentity: {
                    popupId: 'model-dropdown-popup',
                    windowLabel: 'popup-model-dropdown-popup',
                    popupSessionVersion: 1,
                },
            },
        });

        expect(wrapper.get('input').attributes('placeholder')).toBe(
            'Search model name, ID, or provider'
        );

        const badges = wrapper.findAll('.model-dropdown-state-badge');
        expect(badges.map((badge) => badge.text())).toEqual(['Current', 'Default']);
        for (const badge of badges) {
            expect(badge.classes()).not.toContain('truncate');
            expect(badge.classes().some((className) => className.startsWith('max-w-'))).toBe(false);
            expect(badge.classes()).toContain('whitespace-nowrap');
        }
    });

    it('renders the empty setup prompt in natural English', () => {
        setLocale('en-US');

        const wrapper = mount(ModelDropdownPopup, {
            props: {
                data: {
                    activeModelId: '',
                    activeProviderId: null,
                    selectedModelId: '',
                    selectedProviderId: null,
                    searchQuery: '',
                    models: [],
                },
                isInPopup: true,
                popupIdentity: {
                    popupId: 'model-dropdown-popup',
                    windowLabel: 'popup-model-dropdown-popup',
                    popupSessionVersion: 1,
                },
            },
        });

        const normalizedText = wrapper.text().replace(/\s+/g, ' ').trim();
        expect(normalizedText).toContain('No available models yet');
        expect(normalizedText).toContain('Configure models in Settings first');
        expect(normalizedText).not.toContain('Configure models inSettingsfirst');
    });

    it('uses the configured toggle shortcut and ignores the old default', () => {
        const wrapper = mount(ModelDropdownPopup, {
            props: {
                data: {
                    activeModelId: '',
                    activeProviderId: null,
                    selectedModelId: '',
                    selectedProviderId: null,
                    searchQuery: '',
                    toggleShortcut: 'Alt+M',
                    models: [],
                },
                isInPopup: true,
            },
        });
        const handleKeyDown = (
            wrapper.vm as unknown as { handleKeyDown: (event: KeyboardEvent) => void }
        ).handleKeyDown;

        handleKeyDown(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true }));
        expect(wrapper.emitted('close')).toBeUndefined();

        handleKeyDown(new KeyboardEvent('keydown', { key: 'm', altKey: true }));
        expect(wrapper.emitted('close')).toHaveLength(1);
    });

    it('does not close from the old toggle shortcut when the shortcut is disabled', () => {
        const wrapper = mount(ModelDropdownPopup, {
            props: {
                data: {
                    activeModelId: '',
                    activeProviderId: null,
                    selectedModelId: '',
                    selectedProviderId: null,
                    searchQuery: '',
                    toggleShortcut: null,
                    models: [],
                },
                isInPopup: true,
            },
        });
        const handleKeyDown = (
            wrapper.vm as unknown as { handleKeyDown: (event: KeyboardEvent) => void }
        ).handleKeyDown;

        handleKeyDown(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true }));

        expect(wrapper.emitted('close')).toBeUndefined();
    });
});
