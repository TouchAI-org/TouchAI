import type { Provider } from '@database/schema';
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ProviderConfig from '@/views/SettingsView/components/AiServices/components/ProviderConfig.vue';

const authServiceMock = vi.hoisted(() => ({
    getManagedAuthState: vi.fn(),
    logoutManagedAuth: vi.fn().mockResolvedValue(undefined),
    openManagedLogin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/AuthService', () => authServiceMock);

vi.mock('@components/PasswordInput.vue', () => ({
    default: {
        name: 'PasswordInputStub',
        props: ['modelValue', 'placeholder'],
        emits: ['update:modelValue', 'input'],
        template:
            '<input data-testid="password-input" :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value); $emit(\'input\')" />',
    },
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@/services/AgentService', () => ({
    aiService: {
        createProviderInstance: () => ({
            getApiTargets: () => ({
                generationTarget: 'https://hub.touch-ai.org/api/v1/chat/completions',
            }),
        }),
    },
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    getProviderDriverDefinition: () => ({
        driver: 'mimo',
        label: 'Xiaomi MiMo',
        logo: 'mimo.png',
        placeholder: 'https://token-plan-cn.xiaomimimo.com/v1',
    }),
    parseProviderConfigJson: (configJson: string | null) => (configJson ? JSON.parse(configJson) : {}),
    isTouchAiManagedMode: (config: { touchAiMode?: 'managed' | 'custom' }, baseUrl: string) =>
        config.touchAiMode === 'custom'
            ? false
            : config.touchAiMode === 'managed'
              ? true
              : baseUrl === 'https://hub.touch-ai.org/api/v1',
}));

function createProvider(overrides: Partial<Provider> = {}): Provider {
    return {
        id: 100,
        name: 'Xiaomi MiMo',
        driver: 'mimo',
        api_endpoint: 'https://hub.touch-ai.org/api/v1',
        api_key: null,
        config_json: null,
        logo: 'mimo.png',
        enabled: 0,
        is_builtin: 1,
        created_at: '',
        updated_at: '',
        ...overrides,
    };
}

describe('ProviderConfig managed TouchAI activity provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        authServiceMock.getManagedAuthState.mockResolvedValue({
            providerId: 100,
            isLoggedIn: false,
            login: null,
            avatarUrl: null,
        });
    });

    it('shows managed activity controls without exposing a key input', async () => {
        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider(),
            },
        });

        await flushPromises();

        expect(wrapper.find('[data-testid="settings-managed-activity-provider"]').exists()).toBe(
            true
        );
        expect(
            wrapper.find('[data-testid="settings-managed-activity-api-key-input"]').exists()
        ).toBe(false);
        expect(wrapper.find('input[placeholder="sk-..."]').exists()).toBe(false);
    });

    it('switches the managed provider config to the custom endpoint and key form', async () => {
        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider(),
            },
        });

        await flushPromises();
        await wrapper.get('[data-testid="settings-ai-services-mode-custom"]').trigger('click');
        await flushPromises();

        expect(wrapper.find('[data-testid="settings-managed-activity-provider"]').exists()).toBe(
            false
        );
        expect(wrapper.find('[data-testid="password-input"]').exists()).toBe(true);
        expect(wrapper.find('input[placeholder="sk-..."]').exists()).toBe(true);
    });

    it('renders the managed activity as a compact single-row authorization bar', async () => {
        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider(),
            },
        });

        await flushPromises();

        expect(wrapper.find('[data-testid="settings-managed-activity-status"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="settings-managed-activity-copy"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="settings-managed-activity-logout-button"]').exists()).toBe(
            false
        );
    });

    it('opens the managed TouchAI Hub login flow', async () => {
        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider(),
            },
        });

        await flushPromises();
        await wrapper.get('[data-testid="settings-managed-activity-page-button"]').trigger('click');

        expect(authServiceMock.openManagedLogin).toHaveBeenCalled();
    });

    it('shows a reauthorize action when the managed provider is already signed in', async () => {
        authServiceMock.getManagedAuthState.mockResolvedValue({
            providerId: 100,
            isLoggedIn: true,
            login: 'octocat',
            avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        });

        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider({ api_key: 'ta_live_abc' }),
            },
        });

        await flushPromises();

        expect(wrapper.get('[data-testid="settings-managed-activity-status"]').text()).toContain(
            'octocat'
        );
        expect(wrapper.get('[data-testid="settings-managed-activity-page-button"]').text()).not.toBe(
            ''
        );
        expect(wrapper.get('[data-testid="settings-managed-activity-cancel-button"]').text()).toBe(
            '取消授权'
        );
        expect(
            wrapper.find('[data-testid="settings-managed-activity-cancel-button"]').exists()
        ).toBe(true);
    });

    it('falls back to the github icon when the managed avatar fails to load', async () => {
        authServiceMock.getManagedAuthState.mockResolvedValue({
            providerId: 100,
            isLoggedIn: true,
            login: 'octocat',
            avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        });

        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider({ api_key: 'ta_live_abc' }),
            },
        });

        await flushPromises();
        await wrapper.get('img').trigger('error');

        expect(
            wrapper.find('[data-testid="settings-managed-activity-github-avatar"]').exists()
        ).toBe(true);
        expect(wrapper.get('[data-testid="app-icon"]').attributes('data-name')).toBe('github');
    });

    it('uses the managed activity label for the built-in mimo mode tab', async () => {
        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider(),
            },
        });

        await flushPromises();

        expect(wrapper.get('[data-testid="settings-ai-services-mode-managed"]').text()).toBe(
            '限免活动'
        );
    });

    it('clears the local managed authorization when the cancel button is used', async () => {
        authServiceMock.getManagedAuthState.mockResolvedValue({
            providerId: 100,
            isLoggedIn: true,
            login: 'octocat',
            avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        });

        const wrapper = mount(ProviderConfig, {
            props: {
                provider: createProvider({ api_key: 'ta_live_abc' }),
            },
        });

        await flushPromises();
        await wrapper.get('[data-testid="settings-managed-activity-cancel-button"]').trigger('click');
        await flushPromises();

        expect(authServiceMock.logoutManagedAuth).toHaveBeenCalledTimes(1);
        expect(wrapper.find('[data-testid="settings-managed-activity-cancel-button"]').exists()).toBe(
            false
        );
        expect(wrapper.get('[data-testid="settings-managed-activity-status"]').text()).toContain(
            '未授权'
        );
    });
});
