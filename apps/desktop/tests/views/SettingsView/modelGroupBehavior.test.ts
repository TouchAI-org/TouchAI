import { flushPromises, mount } from '@vue/test-utils';
import { vi } from 'vitest';

import ModelGroup from '@/views/SettingsView/components/AiServices/components/ModelGroup.vue';

const confirmMock = vi.hoisted(() => vi.fn());
const warningMock = vi.hoisted(() => vi.fn());

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@composables/useConfirm', () => ({
    useConfirm: () => ({
        confirm: confirmMock,
    }),
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({
        warning: warningMock,
    }),
}));

describe('ModelGroup behavior', () => {
    beforeEach(() => {
        confirmMock.mockReset();
        confirmMock.mockResolvedValue(false);
        warningMock.mockReset();
    });

    const createModel = (id: number, modelId: string) => ({
        id,
        provider_id: 1,
        name: modelId,
        model_id: modelId,
        is_default: 0,
        last_used_at: null,
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
        created_at: '',
        updated_at: '',
    });

    it('toggles expansion and forwards child model actions', async () => {
        const model = createModel(7, 'gpt-5');
        const wrapper = mount(ModelGroup, {
            props: {
                group: {
                    groupKey: 'gpt',
                    groupName: 'gpt',
                    models: [model],
                },
                defaultModelId: null,
                providerEnabled: true,
            },
            global: {
                stubs: {
                    ModelCard: {
                        props: ['model'],
                        emits: ['update', 'delete', 'set-default', 'edit'],
                        template: `
                            <div>
                                <button data-testid="model-update" @click="$emit('update', { name: 'next' })">update</button>
                                <button data-testid="model-delete" @click="$emit('delete')">delete</button>
                                <button data-testid="model-default" @click="$emit('set-default')">default</button>
                                <button data-testid="model-edit" @click="$emit('edit')">edit</button>
                            </div>
                        `,
                    },
                },
            },
        });

        const modelContainer = wrapper.get('[data-testid="settings-model-group-models"]');
        expect(modelContainer.attributes('style') ?? '').not.toContain('display: none');

        await wrapper.findAll('button')[0]!.trigger('click');
        expect(
            wrapper.get('[data-testid="settings-model-group-models"]').attributes('style') ?? ''
        ).toContain('display: none');

        await wrapper.get('[data-testid="model-update"]').trigger('click');
        await wrapper.get('[data-testid="model-delete"]').trigger('click');
        await wrapper.get('[data-testid="model-default"]').trigger('click');
        await wrapper.get('[data-testid="model-edit"]').trigger('click');

        expect(wrapper.emitted('update')?.[0]).toEqual([7, { name: 'next' }]);
        expect(wrapper.emitted('delete')?.[0]).toEqual([7]);
        expect(wrapper.emitted('set-default')?.[0]).toEqual([7]);
        expect(wrapper.emitted('edit')?.[0]).toEqual([model]);
    });

    it('blocks deleting a group that contains the default model', async () => {
        const wrapper = mount(ModelGroup, {
            props: {
                group: {
                    groupKey: 'gpt',
                    groupName: 'gpt',
                    models: [createModel(1, 'gpt-5')],
                },
                defaultModelId: 1,
                providerEnabled: true,
            },
            global: {
                stubs: {
                    ModelCard: true,
                },
            },
        });

        await wrapper.find('button[title="删除分组"]').trigger('click');
        await flushPromises();

        expect(warningMock).toHaveBeenCalledWith('该分组包含默认模型，无法批量删除');
        expect(confirmMock).not.toHaveBeenCalled();
        expect(wrapper.emitted('delete-group')).toBeUndefined();
    });

    it('confirms before deleting a non-default group', async () => {
        confirmMock.mockResolvedValueOnce(true);
        const wrapper = mount(ModelGroup, {
            props: {
                group: {
                    groupKey: 'gpt',
                    groupName: 'gpt',
                    models: [createModel(1, 'gpt-5')],
                },
                defaultModelId: null,
                providerEnabled: true,
            },
            global: {
                stubs: {
                    ModelCard: true,
                },
            },
        });

        await wrapper.find('button[title="删除分组"]').trigger('click');

        expect(confirmMock).toHaveBeenCalledWith({
            title: '确认删除',
            message: '确定要删除该分组下的所有模型吗？',
            type: 'danger',
            confirmText: '删除',
            cancelText: '取消',
        });
        expect(wrapper.emitted('delete-group')?.[0]).toEqual(['gpt']);
    });
});
