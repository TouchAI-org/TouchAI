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
        reasoning_options: null,
        release_date: null,
        temperature: 1,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        upstream_metadata: null,
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
            },
        });

        expect(wrapper.find('input[type="radio"]').exists()).toBe(false);
        expect(wrapper.get('button[title="Set as default model"]').text()).toBe('Set as default');
        expect(wrapper.get('button[title="Edit"]').attributes('aria-label')).toBe('Edit');
        expect(wrapper.get('button[title="Delete"]').attributes('aria-label')).toBe('Delete');

        await wrapper.get('button[title="Delete"]').trigger('click');

        expect(confirmMock).toHaveBeenCalledWith({
            title: 'Confirm deletion',
            message: 'Delete model "Model A"?',
            type: 'danger',
            confirmText: 'Delete',
            cancelText: 'Cancel',
        });
    });

    it('emits the default selection from the model action', async () => {
        const wrapper = mount(ModelCard, {
            props: {
                model: createModel(),
                isDefault: false,
            },
        });

        await wrapper.get('button[title="设为默认模型"]').trigger('click');

        expect(wrapper.emitted('set-default')).toEqual([[]]);
    });

    it('shows the default badge on the model logo without a default action button', async () => {
        const wrapper = mount(ModelCard, {
            props: {
                model: createModel(),
                isDefault: true,
            },
        });

        const badge = wrapper.get('[data-testid="default-model-badge"]');

        expect(badge.element.tagName).toBe('SPAN');
        expect(badge.text()).toBe('默认');
        expect(badge.classes()).toContain('absolute');
        expect(badge.classes()).toContain('top-0');
        expect(badge.classes()).toContain('right-0');
        expect(wrapper.find('button[title="设为默认模型"]').exists()).toBe(false);
        expect(wrapper.emitted('set-default')).toBeUndefined();

        setLocale('en-US');
        await wrapper.vm.$nextTick();

        expect(wrapper.get('[data-testid="default-model-badge"]').text()).toBe('Default');

        await wrapper.setProps({ isDefault: false });

        expect(wrapper.find('[data-testid="default-model-badge"]').exists()).toBe(false);

        const setDefaultButton = wrapper.get('button[title="Set as default model"]');

        expect(setDefaultButton.text()).toBe('Set as default');
        expect(setDefaultButton.attributes('disabled')).toBeUndefined();

        await setDefaultButton.trigger('click');

        expect(wrapper.emitted('set-default')).toEqual([[]]);
    });

    it('localizes default-model delete validation in English', async () => {
        setLocale('en-US');

        const wrapper = mount(ModelCard, {
            props: {
                model: createModel(),
                isDefault: true,
            },
        });

        await wrapper.get('button[title="Delete"]').trigger('click');

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
