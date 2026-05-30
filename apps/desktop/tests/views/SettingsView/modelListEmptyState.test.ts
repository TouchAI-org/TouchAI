import { mount } from '@vue/test-utils';
import { vi } from 'vitest';

import ModelList from '@/views/SettingsView/components/AiServices/components/ModelList.vue';

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({
        error: vi.fn(),
        success: vi.fn(),
        info: vi.fn(),
        warning: vi.fn(),
    }),
}));

describe('ModelList empty state', () => {
    const buildWrapper = (apiEndpoint = '') =>
        mount(ModelList, {
            props: {
                providerId: 1,
                models: [],
                entryModelId: null,
                providerEnabled: true,
                refreshing: false,
                provider: {
                    id: 1,
                    name: 'OpenAI',
                    driver: 'openai',
                    api_endpoint: apiEndpoint,
                    api_key: null,
                    config_json: null,
                    logo: 'openai.png',
                    enabled: 1,
                    is_builtin: 1,
                    created_at: '',
                    updated_at: '',
                },
            },
            global: {
                stubs: {
                    AddModelDialog: true,
                    EditModelDialog: true,
                },
            },
        });

    it('removes the empty-state helper copy while still avoiding duplicate buttons', () => {
        const wrapper = buildWrapper();

        expect(wrapper.text()).toContain('暂无模型');
        expect(wrapper.text()).not.toContain('建立第一个模型');
        expect(wrapper.text()).not.toContain('同步模型列表');
        expect(wrapper.text()).not.toContain('获取模型列表');
        expect(wrapper.text()).not.toContain('手动添加');
    });

    it('keeps the ready empty state free of helper copy and duplicate actions', () => {
        const wrapper = buildWrapper('https://api.example.com');

        expect(wrapper.text()).toContain('暂无模型');
        expect(wrapper.text()).not.toContain('建立第一个模型');
        expect(wrapper.text()).not.toContain('同步模型列表');
        expect(wrapper.text()).not.toContain('获取模型列表');
        expect(wrapper.text()).not.toContain('手动添加');
    });
});
