import { mount } from '@vue/test-utils';
import { vi } from 'vitest';

import ProviderConfig from '@/views/SettingsView/components/AiServices/components/ProviderConfig.vue';

vi.mock('@/services/AgentService', () => ({
    aiService: {
        createProviderInstance: vi.fn(() => ({
            getApiTargets: () => ({
                generationTarget: 'https://api.example.com/v1/chat/completions',
            }),
        })),
    },
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    getProviderDriverDefinition: vi.fn(() => ({
        label: 'OpenAI',
        placeholder: 'https://api.example.com',
        logo: 'openai.png',
    })),
}));

vi.mock('@components/PasswordInput.vue', () => ({
    default: {
        name: 'PasswordInputStub',
        props: ['modelValue', 'placeholder'],
        template: '<input data-testid="password-input-stub" :placeholder="placeholder" />',
    },
}));

describe('ProviderConfig', () => {
    it('uses 请求地址 as the endpoint field label', () => {
        const wrapper = mount(ProviderConfig, {
            props: {
                provider: {
                    id: 1,
                    name: 'OpenAI',
                    driver: 'openai',
                    api_endpoint: 'https://api.example.com',
                    api_key: null,
                    config_json: null,
                    logo: 'openai.png',
                    enabled: 1,
                    is_builtin: 1,
                    created_at: '',
                    updated_at: '',
                },
            },
        });

        expect(wrapper.text()).toContain('请求地址 *');
        expect(wrapper.text()).not.toContain('Base URL *');
    });
});
