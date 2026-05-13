import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import ModelDropdownPopup from './index.vue';

const { openSettingsWindow } = vi.hoisted(() => ({
    openSettingsWindow: vi.fn(),
}));

vi.mock('@services/NativeService', () => ({
    native: {
        window: {
            openSettingsWindow,
        },
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/ModelCapabilityTags.vue', () => ({
    default: {
        name: 'ModelCapabilityTags',
        template: '<span data-testid="model-capability-tags" />',
    },
}));

vi.mock('@components/ModelLogo.vue', () => ({
    default: {
        name: 'ModelLogo',
        template: '<span data-testid="model-logo" />',
    },
}));

describe('ModelDropdownPopup', () => {
    it('shows a settings action when no models are configured', async () => {
        const wrapper = mount(ModelDropdownPopup, {
            props: {
                data: {
                    activeModelId: '',
                    activeProviderId: null,
                    selectedModelId: '',
                    selectedProviderId: null,
                    models: [],
                    searchQuery: '',
                },
                isInPopup: true,
                popupIdentity: {
                    popupId: 'model-dropdown-popup-1',
                    windowLabel: 'popup-1',
                    popupSessionVersion: 1,
                },
            },
            global: {
                stubs: {
                    AppIcon: true,
                    ModelCapabilityTags: true,
                    ModelLogo: true,
                },
            },
        });

        const settingsButton = wrapper.get('button');
        expect(settingsButton.text()).toBe('前往设置中心');

        await settingsButton.trigger('click');

        expect(openSettingsWindow).toHaveBeenCalledOnce();
        expect(wrapper.emitted('close')).toHaveLength(1);
    });
});
