// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { Model } from '@database/schema';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import ModelFormDialog from '@/views/SettingsView/components/AiServices/components/ModelFormDialog.vue';

const alertMock = vi.hoisted(() => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
}));

vi.mock('@composables/useAlert', () => ({ useAlert: () => alertMock }));

// The dialog chrome is covered by its own test; here the form is what matters.
vi.mock('@components/DialogShell.vue', () => ({
    default: {
        name: 'DialogShell',
        props: ['open'],
        emits: ['close', 'closed'],
        template: '<section data-testid="dialog-shell"><slot /></section>',
    },
}));

function model(overrides: Partial<Model> = {}): Model {
    return {
        id: 3,
        provider_id: 1,
        name: 'GPT 5',
        model_id: 'gpt-5',
        reasoning: 1,
        tool_call: 1,
        attachment: 0,
        open_weights: 0,
        modalities: JSON.stringify({ input: ['text', 'image'], output: ['text'] }),
        is_custom_metadata: 0,
        is_default: 0,
        created_at: '',
        updated_at: '',
        ...overrides,
    } as Model;
}

type DialogProps = InstanceType<typeof ModelFormDialog>['$props'];

function mountDialog(props: DialogProps) {
    return mount(ModelFormDialog, { props });
}

function saveButton(wrapper: ReturnType<typeof mountDialog>) {
    return wrapper.findAll('button').find((button) => /保存|创建|Save|Create/.test(button.text()))!;
}

function cancelButton(wrapper: ReturnType<typeof mountDialog>) {
    return wrapper.findAll('button').find((button) => /取消|Cancel/.test(button.text()))!;
}

function capabilityButton(wrapper: ReturnType<typeof mountDialog>, label: string) {
    return wrapper.findAll('button').find((button) => button.text() === label)!;
}

beforeEach(() => {
    vi.clearAllMocks();
    setLocale('zh-CN');
});

describe('user adds a model to a provider', () => {
    it('user sees an empty form for a new model', () => {
        const wrapper = mountDialog({ mode: 'create', providerId: 1 });

        expect(wrapper.text()).toContain('添加模型');
        expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
        expect(capabilityButton(wrapper, '推理').classes()).not.toContain('bg-primary-50');
    });

    it('user is told to fill in both fields before saving', async () => {
        const wrapper = mountDialog({ mode: 'create', providerId: 1 });

        await saveButton(wrapper).trigger('click');

        expect(alertMock.error).toHaveBeenCalledTimes(1);
        expect(wrapper.emitted('create')).toBeUndefined();
    });

    it('user creates a model with only its name and id when no capability is chosen', async () => {
        const wrapper = mountDialog({ mode: 'create', providerId: 1 });
        const inputs = wrapper.findAll('input');

        await inputs[0]!.setValue('My model');
        await inputs[1]!.setValue('my-model');
        await saveButton(wrapper).trigger('click');

        expect(wrapper.emitted('create')).toEqual([
            [
                {
                    provider_id: 1,
                    name: 'My model',
                    model_id: 'my-model',
                    is_default: 0,
                },
            ],
        ]);
    });

    it('user creates a model whose chosen capabilities are saved with it', async () => {
        const wrapper = mountDialog({ mode: 'create', providerId: 1 });
        const inputs = wrapper.findAll('input');

        await inputs[0]!.setValue('My model');
        await inputs[1]!.setValue('my-model');
        await capabilityButton(wrapper, '推理').trigger('click');
        await capabilityButton(wrapper, '多模态').trigger('click');
        await saveButton(wrapper).trigger('click');

        const created = wrapper.emitted('create')![0]![0] as Record<string, unknown>;
        expect(created.reasoning).toBe(1);
        expect(created.tool_call).toBe(0);
        expect(created.is_custom_metadata).toBe(1);
        expect(created.modalities).toBe(
            JSON.stringify({ input: ['text', 'image'], output: ['text'] })
        );
    });

    it('user sees a capability chip toggle on and off', async () => {
        const wrapper = mountDialog({ mode: 'create', providerId: 1 });
        const chip = capabilityButton(wrapper, '推理');

        expect(chip.classes()).toContain('bg-neutral-100');

        await chip.trigger('click');
        expect(chip.classes()).toContain('bg-blue-50');

        await chip.trigger('click');
        expect(chip.classes()).toContain('bg-neutral-100');
    });

    it('user cancels without creating anything', async () => {
        const wrapper = mountDialog({ mode: 'create', providerId: 1 });

        await cancelButton(wrapper).trigger('click');

        expect(wrapper.emitted('cancel')).toHaveLength(1);
        expect(wrapper.emitted('create')).toBeUndefined();
    });
});

describe('user edits an existing model', () => {
    it('user sees the saved values filled in', () => {
        const wrapper = mountDialog({ mode: 'edit', model: model() });

        expect(wrapper.text()).toContain('编辑模型');
        const inputs = wrapper.findAll('input');
        expect((inputs[0]!.element as HTMLInputElement).value).toBe('GPT 5');
        expect((inputs[1]!.element as HTMLInputElement).value).toBe('gpt-5');
        expect(capabilityButton(wrapper, '推理').classes()).toContain('bg-blue-50');
        expect(capabilityButton(wrapper, '多模态').classes()).toContain('bg-purple-50');
        expect(capabilityButton(wrapper, '文件').classes()).toContain('bg-neutral-100');
    });

    it('user renames a model without touching its capabilities', async () => {
        const wrapper = mountDialog({ mode: 'edit', model: model() });

        await wrapper.findAll('input')[0]!.setValue('GPT 5.1');
        await saveButton(wrapper).trigger('click');

        expect(wrapper.emitted('update')).toEqual([[{ name: 'GPT 5.1', model_id: 'gpt-5' }]]);
    });

    it('user saves capability changes along with the name', async () => {
        const wrapper = mountDialog({ mode: 'edit', model: model() });

        await capabilityButton(wrapper, '文件').trigger('click');
        await saveButton(wrapper).trigger('click');

        const updated = wrapper.emitted('update')![0]![0] as Record<string, unknown>;
        expect(updated.attachment).toBe(1);
        expect(updated.is_custom_metadata).toBe(1);
    });

    it('user sees the model reloaded when a different model is opened in the same dialog', async () => {
        const wrapper = mountDialog({ mode: 'edit', model: model() });

        await wrapper.setProps({ model: model({ id: 9, name: 'Claude', model_id: 'claude' }) });

        expect((wrapper.findAll('input')[0]!.element as HTMLInputElement).value).toBe('Claude');
    });

    it('user sees the form reset to the saved values after cancelling and reopening', async () => {
        const wrapper = mountDialog({ mode: 'edit', model: model(), open: true });

        await wrapper.findAll('input')[0]!.setValue('unsaved edit');
        await wrapper.setProps({ open: false });
        await wrapper.setProps({ open: true });

        expect((wrapper.findAll('input')[0]!.element as HTMLInputElement).value).toBe('GPT 5');
    });

    it('user is told to fill in both fields before saving an edit', async () => {
        const wrapper = mountDialog({ mode: 'edit', model: model({ name: '' }) });

        await saveButton(wrapper).trigger('click');

        expect(alertMock.error).toHaveBeenCalledTimes(1);
        expect(wrapper.emitted('update')).toBeUndefined();
    });

    it('user sees the English labels when the app is in English', () => {
        setLocale('en-US');

        const wrapper = mountDialog({ mode: 'create', providerId: 1 });

        expect(wrapper.text()).toContain('Add model');
        expect(wrapper.text()).toContain('Cancel');
    });
});
