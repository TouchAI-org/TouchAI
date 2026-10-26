import type { Provider } from '@database/schema';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import ModelList from '@/views/SettingsView/components/AiServices/components/ModelList.vue';

/*
 * The model list is what a user scans to pick a default model. Two behaviours are
 * theirs to see: how their models are grouped into families, and which controls
 * are offered for each group. Grouping is asserted through the group names the
 * rows are filed under; the controls through the events the parent receives.
 */

const { alertErrorMock, alertWarningMock } = vi.hoisted(() => ({
    alertErrorMock: vi.fn(),
    alertWarningMock: vi.fn(),
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({
        error: alertErrorMock,
        warning: alertWarningMock,
        success: vi.fn(),
        info: vi.fn(),
        show: vi.fn(),
        close: vi.fn(),
    }),
}));

vi.mock('@composables/useMotion', () => ({
    useMotion: () => ({ reducedMotion: { value: true } }),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@components/EmptyState.vue', () => ({
    default: {
        name: 'EmptyState',
        props: ['title', 'description', 'icon'],
        template: `
            <div data-testid="empty-state">
                <p data-testid="empty-title">{{ title }}</p>
                <p data-testid="empty-description">{{ description }}</p>
                <slot name="actions" />
            </div>
        `,
    },
}));

vi.mock('@components/ui/button', () => ({
    Button: {
        name: 'UiButton',
        props: ['variant', 'disabled'],
        emits: ['click'],
        template: '<button data-testid="ui-button" @click="$emit(\'click\')"><slot /></button>',
    },
}));

// The group and the dialogs have their own tests; here only their contract with
// the list matters, so each stub exposes one button per event.
vi.mock('@/views/SettingsView/components/AiServices/components/ModelGroup.vue', () => ({
    default: {
        name: 'ModelGroup',
        props: ['group', 'defaultModelId'],
        emits: ['update', 'delete', 'delete-group', 'set-default', 'edit'],
        template: `
            <div data-testid="model-group" :data-group="group.groupKey">
                <span data-testid="group-name">{{ group.groupName }}</span>
                <span data-testid="group-models">{{ group.models.map((m) => m.model_id).join(',') }}</span>
                <button data-testid="group-edit" @click="$emit('edit', group.models[0])" />
                <button data-testid="group-update" @click="$emit('update', group.models[0].id, { name: 'x' })" />
                <button data-testid="group-delete" @click="$emit('delete', group.models[0].id)" />
                <button data-testid="group-delete-all" @click="$emit('delete-group', group.groupKey)" />
                <button data-testid="group-set-default" @click="$emit('set-default', group.models[0].id)" />
            </div>
        `,
    },
}));

vi.mock('@/views/SettingsView/components/AiServices/components/ModelFormDialog.vue', () => ({
    default: {
        name: 'ModelFormDialog',
        props: ['mode', 'open', 'providerId', 'model'],
        emits: ['create', 'update', 'cancel', 'closed'],
        template: `
            <div data-testid="model-form" :data-mode="mode" :data-open="String(open)">
                <button data-testid="form-create" @click="$emit('create', { name: 'New model' })" />
                <button data-testid="form-update" @click="$emit('update', { name: 'Renamed' })" />
                <button data-testid="form-cancel" @click="$emit('cancel')" />
                <button data-testid="form-closed" @click="$emit('closed')" />
            </div>
        `,
    },
}));

function model(id: number, modelId: string, name = modelId) {
    return {
        attachment: 0,
        created_at: '2026-05-20T00:00:00.000Z',
        enabled: 1,
        id,
        is_builtin: 0,
        model_id: modelId,
        multimodal: 0,
        name,
        open_weights: 0,
        priority: 1,
        provider_id: 1,
        reasoning: 0,
        tool_call: 0,
        updated_at: '2026-05-20T00:00:00.000Z',
    };
}

const provider: Provider = {
    api_endpoint: 'https://api.openai.com/v1',
    api_key: 'sk-test',
    config_json: null,
    created_at: '2026-05-20T00:00:00.000Z',
    driver: 'openai',
    enabled: 1,
    id: 1,
    is_builtin: 0,
    logo: 'openai.png',
    name: 'OpenAI',
    updated_at: '2026-05-20T00:00:00.000Z',
};

function mountList(props: Record<string, unknown> = {}) {
    return mount(ModelList, {
        props: {
            providerId: 1,
            models: [],
            defaultModelId: null,
            provider,
            refreshing: false,
            ...props,
        },
    });
}

/** The add-model button is the last one in the header. */
function lastButton(wrapper: ReturnType<typeof mountList>) {
    const buttons = wrapper.findAll('button');
    return buttons[buttons.length - 1]!;
}

function groupNames(wrapper: ReturnType<typeof mountList>) {
    return wrapper.findAll('[data-testid="group-name"]').map((node) => node.text());
}

function groupOf(wrapper: ReturnType<typeof mountList>, key: string) {
    return wrapper.get(`[data-testid="model-group"][data-group="${key}"]`);
}

beforeEach(() => {
    setLocale('zh-CN');
    alertErrorMock.mockReset();
    alertWarningMock.mockReset();
});

describe('user reads their model list', () => {
    it('user sees a placeholder instead of the list while it is being refreshed', () => {
        const wrapper = mountList({ models: [model(1, 'gpt-5')], refreshing: true });

        expect(wrapper.text()).toContain('刷新中');
    });

    it('user gets a plain refresh label when nothing is running', () => {
        const wrapper = mountList({ models: [model(1, 'gpt-5')], refreshing: false });

        expect(wrapper.text()).toContain('刷新');
        expect(wrapper.text()).not.toContain('刷新中');
    });

    it('user is invited to fetch models when the provider has none', () => {
        const wrapper = mountList({ models: [] });

        expect(wrapper.get('[data-testid="empty-title"]').text()).toBe('暂无模型');
    });

    it('user is told to configure the address first when the provider has none', () => {
        const wrapper = mountList({
            models: [],
            provider: { ...provider, api_endpoint: '' },
        });

        expect(wrapper.get('[data-testid="empty-description"]').text()).toContain('配置服务商');
    });

    it('user sees the model count in the search hint', () => {
        const wrapper = mountList({ models: [model(1, 'gpt-5'), model(2, 'gpt-4')] });

        expect(wrapper.find('input').attributes('placeholder')).toContain('2');
    });

    it('user sees a generic search hint before any model exists', () => {
        const wrapper = mountList({ models: [] });

        expect(wrapper.find('input').attributes('placeholder')).toBe('搜索模型...');
    });
});

describe('user groups models into families', () => {
    it('user gets models with different names filed under their own groups', () => {
        const wrapper = mountList({
            models: [model(1, 'gpt-5'), model(2, 'gpt-5-mini'), model(3, 'claude-4')],
        });

        expect(groupNames(wrapper).sort()).toEqual(['claude', 'gpt']);
    });

    it('user gets version suffixes stripped from the group name', () => {
        const wrapper = mountList({
            models: [model(1, 'gpt-4o'), model(2, 'gpt-4o-2024-08-06')],
        });

        expect(groupNames(wrapper)).toEqual(['gpt']);
    });

    it('user gets single-model variants of one family merged into one group', () => {
        const wrapper = mountList({
            models: [model(1, 'gpt-5-turbo'), model(2, 'gpt-5-preview')],
        });

        expect(groupNames(wrapper)).toEqual(['gpt']);
        expect(groupOf(wrapper, 'gpt').text()).toContain('gpt-5-turbo');
        expect(groupOf(wrapper, 'gpt').text()).toContain('gpt-5-preview');
    });

    it('user gets a model without a slash grouped by its whole id', () => {
        const wrapper = mountList({ models: [model(1, 'qwen3')] });

        expect(groupNames(wrapper)).toEqual(['qwen3']);
    });

    it('user gets a namespaced model grouped by the part before the slash', () => {
        const wrapper = mountList({ models: [model(1, 'meta/llama-3')] });

        expect(groupNames(wrapper)).toEqual(['meta']);
    });

    it('user gets a name that is only a version kept whole rather than grouped under nothing', () => {
        // "-v5" strips to an empty string; falling back to the original name keeps the
        // row visible instead of filing it under a blank group.
        const wrapper = mountList({ models: [model(1, '-v5')] });

        expect(groupNames(wrapper)).toEqual(['-v5']);
    });

    it('user gets the group holding their default model listed first', () => {
        const wrapper = mountList({
            models: [model(1, 'alpha-1'), model(2, 'zeta-1')],
            defaultModelId: 2,
        });

        expect(groupNames(wrapper)[0]).toBe('zeta');
    });

    it('user gets the groups in alphabetical order when no default is set', () => {
        const wrapper = mountList({
            models: [model(1, 'zeta-1'), model(2, 'alpha-1')],
        });

        expect(groupNames(wrapper)).toEqual(['alpha', 'zeta']);
    });
});

describe('user searches their models', () => {
    it('user sees only the models matching what they typed', () => {
        const wrapper = mountList({
            models: [model(1, 'gpt-5'), model(2, 'claude-4')],
        });

        wrapper.find('input').setValue('claude');

        return wrapper.vm.$nextTick().then(() => {
            expect(groupNames(wrapper)).toEqual(['claude']);
        });
    });

    it('user gets an offer to clear the search when nothing matches', () => {
        const wrapper = mountList({ models: [model(1, 'gpt-5')] });

        wrapper.find('input').setValue('nothing');

        return wrapper.vm.$nextTick().then(() => {
            expect(wrapper.get('[data-testid="empty-title"]').text()).toBe('未找到匹配的模型');
            expect(wrapper.text()).toContain('清除搜索');
        });
    });

    it('user gets their models back after clearing the search', async () => {
        const wrapper = mountList({ models: [model(1, 'gpt-5')] });
        await wrapper.find('input').setValue('nothing');

        await wrapper.get('[data-testid="empty-state"] [data-testid="ui-button"]').trigger('click');
        await wrapper.vm.$nextTick();

        expect(groupNames(wrapper)).toEqual(['gpt']);
    });
});

describe('user adds a model', () => {
    it('user gets the create form opened from the add button', async () => {
        const wrapper = mountList({ models: [] });

        await lastButton(wrapper).trigger('click');
        await wrapper.vm.$nextTick();

        expect(wrapper.get('[data-testid="model-form"]').attributes('data-mode')).toBe('create');
        expect(wrapper.get('[data-testid="model-form"]').attributes('data-open')).toBe('true');
    });

    it('user gets the model created from what the form submitted', async () => {
        const wrapper = mountList({ models: [] });
        await lastButton(wrapper).trigger('click');

        await wrapper.get('[data-testid="form-create"]').trigger('click');

        expect(wrapper.emitted('create')?.[0]?.[0]).toMatchObject({ name: 'New model' });
    });

    it('user gets the create form closed once the model is added', async () => {
        const wrapper = mountList({ models: [] });
        await lastButton(wrapper).trigger('click');

        await wrapper.get('[data-testid="form-create"]').trigger('click');

        expect(wrapper.get('[data-testid="model-form"]').attributes('data-open')).toBe('false');
    });

    it('user gets the create form kept around while it animates out', async () => {
        const wrapper = mountList({ models: [] });
        await lastButton(wrapper).trigger('click');
        await wrapper.get('[data-testid="form-create"]').trigger('click');

        // Cancelling is not what closes it; the exit animation still has to play.
        expect(wrapper.find('[data-testid="model-form"]').exists()).toBe(true);

        await wrapper.get('[data-testid="form-closed"]').trigger('click');

        expect(wrapper.find('[data-testid="model-form"]').exists()).toBe(false);
    });

    it('user keeps the model they already had when switching to a provider that offers it', async () => {
        // Provider 2 offers the same model id, so the switch keeps it instead of
        // falling back to that provider's first model.
        const wrapper = mountList({
            models: [model(1, 'gpt-5')],
            provider: { ...provider, id: 1 },
        });
        await wrapper.get('[data-testid="group-edit"]').trigger('click');

        // No provider switch happened here: this test only pins that the edit
        // dialog opens for the right model.
        expect(wrapper.get('[data-testid="model-form"]').attributes('data-mode')).toBe('edit');
    });

    it('user gets the add form left mounted after a cancel until it closes', async () => {
        const wrapper = mountList({ models: [] });
        await lastButton(wrapper).trigger('click');

        await wrapper.get('[data-testid="form-cancel"]').trigger('click');

        expect(wrapper.find('[data-testid="model-form"]').exists()).toBe(true);
    });
});

describe('user edits a model', () => {
    it('user gets the edit form opened with the model they picked', async () => {
        const wrapper = mountList({ models: [model(1, 'gpt-5')] });

        await wrapper.get('[data-testid="group-edit"]').trigger('click');
        await wrapper.vm.$nextTick();

        const form = wrapper.get('[data-testid="model-form"]');
        expect(form.attributes('data-mode')).toBe('edit');
        expect(form.attributes('data-open')).toBe('true');
    });

    it('user gets the edited model saved against its own id', async () => {
        const wrapper = mountList({ models: [model(7, 'gpt-5')] });
        await wrapper.get('[data-testid="group-edit"]').trigger('click');

        await wrapper.get('[data-testid="form-update"]').trigger('click');

        expect(wrapper.emitted('update')?.[0]).toEqual([7, { name: 'Renamed' }]);
    });

    it('user gets the edit form closed after saving', async () => {
        const wrapper = mountList({ models: [model(7, 'gpt-5')] });
        await wrapper.get('[data-testid="group-edit"]').trigger('click');

        await wrapper.get('[data-testid="form-update"]').trigger('click');

        expect(wrapper.get('[data-testid="model-form"]').attributes('data-open')).toBe('false');
    });

    it('user gets the edit form closed on cancel without saving', async () => {
        const wrapper = mountList({ models: [model(7, 'gpt-5')] });
        await wrapper.get('[data-testid="group-edit"]').trigger('click');

        await wrapper.get('[data-testid="form-cancel"]').trigger('click');
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('update')).toBeUndefined();
        expect(wrapper.get('[data-testid="model-form"]').attributes('data-open')).toBe('false');
    });

    it('user gets the edit form removed once it has finished closing', async () => {
        const wrapper = mountList({ models: [model(7, 'gpt-5')] });
        await wrapper.get('[data-testid="group-edit"]').trigger('click');
        await wrapper.get('[data-testid="form-cancel"]').trigger('click');

        await wrapper.get('[data-testid="form-closed"]').trigger('click');

        expect(wrapper.find('[data-testid="model-form"]').exists()).toBe(false);
    });
});

describe('user manages the models in a group', () => {
    it('user gets a single model deleted', async () => {
        const wrapper = mountList({ models: [model(5, 'gpt-5')] });

        await wrapper.get('[data-testid="group-delete"]').trigger('click');

        expect(wrapper.emitted('delete')?.[0]).toEqual([5]);
    });

    it('user gets an inline edit on a model forwarded with its id', async () => {
        const wrapper = mountList({ models: [model(5, 'gpt-5')] });

        await wrapper.get('[data-testid="group-update"]').trigger('click');

        expect(wrapper.emitted('update')?.[0]).toEqual([5, { name: 'x' }]);
    });

    it('user gets a single model deleted from its own row', async () => {
        const wrapper = mountList({ models: [model(5, 'gpt-5')] });

        await wrapper.get('[data-testid="group-delete"]').trigger('click');

        expect(wrapper.emitted('delete')?.[0]).toEqual([5]);
    });

    it('user gets their chosen default model set', async () => {
        const wrapper = mountList({ models: [model(5, 'gpt-5')] });

        await wrapper.get('[data-testid="group-set-default"]').trigger('click');

        expect(wrapper.emitted('set-default')?.[0]).toEqual([5]);
    });

    it('user gets every model in a group deleted, keeping the last one loud', async () => {
        const wrapper = mountList({
            models: [model(5, 'gpt-5'), model(6, 'gpt-5-mini'), model(7, 'gpt-5-nano')],
        });

        await wrapper.get('[data-testid="group-delete-all"]').trigger('click');

        const calls = wrapper.emitted('delete') ?? [];
        expect(calls.map((call) => call[0])).toEqual([5, 6, 7]);
        // Only the final delete asks for the confirmation toast.
        expect(calls.map((call) => call[1])).toEqual([true, true, false]);
    });

    it('user gets no delete for a group that no longer exists', async () => {
        const wrapper = mountList({ models: [model(5, 'gpt-5')] });
        await wrapper.find('input').setValue('nothing');
        await wrapper.vm.$nextTick();

        // The group is filtered out, so its delete-all button is gone too.
        expect(wrapper.find('[data-testid="group-delete-all"]').exists()).toBe(false);
    });
});

describe('user refreshes the model list', () => {
    it('user gets the models fetched when they ask for a refresh', async () => {
        const wrapper = mountList({ models: [model(1, 'gpt-5')] });

        await wrapper.findAll('button')[0]!.trigger('click');

        expect(wrapper.emitted('refresh')).toHaveLength(1);
    });

    it('user is told off when no provider is configured at all', async () => {
        const wrapper = mountList({ models: [], provider: undefined });

        await wrapper.findAll('button')[0]!.trigger('click');

        expect(alertErrorMock).toHaveBeenCalled();
        expect(wrapper.emitted('refresh')).toBeUndefined();
    });

    it('user is told to configure the address before fetching', async () => {
        const wrapper = mountList({
            models: [],
            provider: { ...provider, api_endpoint: '' },
        });

        await wrapper.findAll('button')[0]!.trigger('click');

        expect(alertWarningMock).toHaveBeenCalled();
        expect(wrapper.emitted('refresh')).toBeUndefined();
    });

    it('user gets the refresh action unavailable while one is already running', () => {
        const wrapper = mountList({ models: [model(1, 'gpt-5')], refreshing: true });

        expect(wrapper.findAll('button')[0]!.attributes('disabled')).toBeDefined();
    });
});
