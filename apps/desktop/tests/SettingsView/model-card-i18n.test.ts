import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { createDomLocalizer } from '@/i18n/domLocalizer';
import ModelCard from '@/views/SettingsView/components/AiServices/components/ModelCard.vue';

const { alertErrorMock, confirmMock } = vi.hoisted(() => ({
    alertErrorMock: vi.fn(),
    confirmMock: vi.fn(),
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({
        error: alertErrorMock,
    }),
}));

vi.mock('@composables/useConfirm', () => ({
    useConfirm: () => ({
        confirm: confirmMock,
    }),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/ModelLogo.vue', () => ({
    default: {
        name: 'ModelLogo',
        props: ['modelId', 'name'],
        template: '<span data-testid="model-logo">{{ name }}</span>',
    },
}));

vi.mock('@components/ModelCapabilityTags.vue', () => ({
    default: {
        name: 'ModelCapabilityTags',
        template: '<span data-testid="capability-tags" />',
    },
}));

function createModel(overrides = {}) {
    return {
        id: 1,
        provider_id: 1,
        model_id: 'model-a',
        name: 'Model A',
        is_default: 0,
        last_used_at: '2026-05-22T06:30:00.000Z',
        attachment: 0,
        modalities: null,
        open_weights: 0,
        reasoning: 0,
        release_date: null,
        temperature: 1,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        is_selected: 1,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        ...overrides,
    };
}

describe('ModelCard i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        confirmMock.mockResolvedValue(false);
        setLocale('zh-CN');
    });

    it('formats last-used timestamp with the active English locale', () => {
        setLocale('en-US');

        const wrapper = mount(ModelCard, {
            props: {
                model: createModel(),
                isDefault: false,
                providerEnabled: true,
            },
        });

        expect(wrapper.text()).toContain('Last used:');
        expect(wrapper.text()).toContain('May');
        expect(wrapper.text()).not.toContain('最后使用');
    });

    it('localizes action titles and delete confirmation in English', async () => {
        setLocale('en-US');

        const wrapper = mount(ModelCard, {
            props: {
                model: createModel(),
                isDefault: false,
                providerEnabled: false,
            },
        });

        const defaultRadio = wrapper.get('input[type="radio"]');
        const buttons = wrapper.findAll('button');

        expect(defaultRadio.attributes('title')).toBe('Enable this provider first');
        expect(buttons[0]?.attributes('title')).toBe('Remove');
        expect(buttons[1]?.attributes('title')).toBe('Edit');
        expect(buttons[2]?.attributes('title')).toBe('Delete');

        await buttons[2]?.trigger('click');

        expect(confirmMock).toHaveBeenCalledWith({
            title: 'Confirm deletion',
            message: 'Delete model "Model A"?',
            type: 'danger',
            confirmText: 'Delete',
            cancelText: 'Cancel',
        });
    });

    it('localizes default-model delete validation in English', async () => {
        setLocale('en-US');

        const wrapper = mount(ModelCard, {
            props: {
                model: createModel(),
                isDefault: true,
                providerEnabled: true,
            },
        });

        await wrapper.findAll('button')[2]?.trigger('click');

        expect(alertErrorMock).toHaveBeenCalledWith(
            'Cannot delete the default model. Set another model as default first.'
        );
    });

    it('does not let the global DOM localizer rewrite dynamic model payload text', () => {
        setLocale('en-US');

        const wrapper = mount(ModelCard, {
            props: {
                model: createModel({ name: '设置' }),
                isDefault: false,
                providerEnabled: true,
            },
            attachTo: document.body,
        });

        const localizer = createDomLocalizer(document.body);
        localizer.translateNow();

        expect(wrapper.get('h4').text()).toBe('设置');
        expect(wrapper.text()).toContain('Last used:');
        expect(wrapper.get('h4').attributes('data-no-i18n')).toBe('true');

        wrapper.unmount();
    });
});
