import type { Provider } from '@database/schema';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import ProviderFormDialog from '@/views/SettingsView/components/AiServices/components/ProviderFormDialog.vue';

/*
 * The provider dialog is the same form in two modes: creating a provider asks for
 * the endpoint, key and the "enable after create" flag, editing only renames it.
 * The assertions below read the title, the fields that are visible and the
 * payload the parent receives, which is what the user and the caller observe.
 */

const { alertErrorMock } = vi.hoisted(() => ({ alertErrorMock: vi.fn() }));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({
        error: alertErrorMock,
        warning: vi.fn(),
        success: vi.fn(),
        info: vi.fn(),
        show: vi.fn(),
        close: vi.fn(),
    }),
}));

vi.mock('@/services/AgentService', () => ({
    aiService: {
        createProviderInstance: () => ({
            getApiTargets: () => ({ generationTarget: 'https://api.openai.com/v1' }),
        }),
    },
}));

vi.mock('@components/DialogShell.vue', () => ({
    default: {
        name: 'DialogShell',
        props: ['open'],
        emits: ['closed'],
        template: '<div data-testid="dialog-shell"><slot /></div>',
    },
}));

vi.mock('@components/CustomSelect.vue', () => ({
    default: {
        name: 'CustomSelect',
        props: ['modelValue', 'options'],
        emits: ['update:modelValue'],
        template: `
            <select
                data-testid="driver-select"
                :value="modelValue"
                @change="$emit('update:modelValue', $event.target.value)"
            >
                <option v-for="option in options" :key="option.value" :value="option.value">
                    {{ option.label }}
                </option>
            </select>
        `,
    },
}));

vi.mock('@components/PasswordInput.vue', () => ({
    default: {
        name: 'PasswordInput',
        props: ['modelValue', 'placeholder'],
        emits: ['update:modelValue'],
        template: '<input data-testid="api-key" type="password" :value="modelValue" />',
    },
}));

vi.mock('@components/ui/button', () => ({
    Button: {
        name: 'UiButton',
        props: ['variant'],
        // Declaring the emit keeps it from also firing as a native listener on the
        // stub's root button, which would report every click twice.
        emits: ['click'],
        template: '<button data-testid="ui-button" @click="$emit(\'click\')"><slot /></button>',
    },
}));

const provider: Provider = {
    api_endpoint: 'https://api.openai.com/v1',
    api_key: 'sk-existing',
    config_json: null,
    created_at: '2026-05-20T00:00:00.000Z',
    driver: 'openai',
    enabled: 1,
    id: 3,
    is_builtin: 0,
    logo: 'openai.png',
    name: 'My OpenAI',
    updated_at: '2026-05-20T00:00:00.000Z',
};

function mountDialog(props: Record<string, unknown> = {}) {
    return mount(ProviderFormDialog, {
        props: { mode: 'create', open: true, ...props },
    });
}

function buttons(wrapper: ReturnType<typeof mountDialog>) {
    return wrapper.findAll('[data-testid="ui-button"]');
}

function nameInput(wrapper: ReturnType<typeof mountDialog>) {
    return wrapper.findAll('input').filter((node) => node.attributes('type') === 'text')[0]!;
}

function endpointInput(wrapper: ReturnType<typeof mountDialog>) {
    return wrapper.findAll('input').filter((node) => node.attributes('type') === 'text')[1]!;
}

beforeEach(() => {
    setLocale('zh-CN');
    alertErrorMock.mockReset();
});

describe('user creates a provider', () => {
    it('user sees the create title and the create submit button', () => {
        const wrapper = mountDialog();

        expect(wrapper.text()).toContain('添加自定义服务商');
        expect(buttons(wrapper)[0]!.text()).toBe('创建');
    });

    it('user sees the endpoint, key and enable fields only when creating', () => {
        const wrapper = mountDialog();

        expect(wrapper.text()).toContain('请求地址');
        expect(wrapper.text()).toContain('API Key');
        expect(wrapper.text()).toContain('创建后立即启用');
        expect(wrapper.find('[data-testid="api-key"]').exists()).toBe(true);
        expect(wrapper.find('#enabled').exists()).toBe(true);
    });

    it('user is asked for the endpoint the chosen driver expects', () => {
        const wrapper = mountDialog();

        expect(endpointInput(wrapper).attributes('placeholder')).toBe('https://api.openai.com');
    });

    it('user gets the provider created with what they filled in', async () => {
        const wrapper = mountDialog();

        await nameInput(wrapper).setValue('  My Provider  ');
        await endpointInput(wrapper).setValue('  https://api.example.com/v1  ');
        await buttons(wrapper)[0]!.trigger('click');

        expect(wrapper.emitted('create')?.[0]?.[0]).toMatchObject({
            name: 'My Provider',
            api_endpoint: 'https://api.example.com/v1',
            driver: 'openai',
            enabled: 1,
            is_builtin: 0,
        });
    });

    it('user gets the trimmed name saved rather than the spaces they typed', async () => {
        const wrapper = mountDialog();

        await nameInput(wrapper).setValue('   Spaced   ');
        await endpointInput(wrapper).setValue('https://api.example.com');
        await buttons(wrapper)[0]!.trigger('click');

        expect((wrapper.emitted('create')?.[0]?.[0] as { name: string }).name).toBe('Spaced');
    });

    it('user gets an unset key saved as empty rather than blank text', async () => {
        const wrapper = mountDialog();

        await nameInput(wrapper).setValue('No key');
        await endpointInput(wrapper).setValue('https://api.example.com');
        await buttons(wrapper)[0]!.trigger('click');

        expect((wrapper.emitted('create')?.[0]?.[0] as { api_key: unknown }).api_key).toBeNull();
    });

    it('user gets the API key they typed saved with the provider', async () => {
        const wrapper = mountDialog();

        await nameInput(wrapper).setValue('Keyed');
        await endpointInput(wrapper).setValue('https://api.example.com');
        wrapper.findComponent({ name: 'PasswordInput' }).vm.$emit('update:modelValue', 'sk-typed');
        await wrapper.vm.$nextTick();
        await buttons(wrapper)[0]!.trigger('click');

        expect((wrapper.emitted('create')?.[0]?.[0] as { api_key: unknown }).api_key).toBe(
            'sk-typed'
        );
    });

    it('user gets a provider created disabled when they untick the enable box', async () => {
        const wrapper = mountDialog();

        await nameInput(wrapper).setValue('Disabled');
        await endpointInput(wrapper).setValue('https://api.example.com');
        await wrapper.get('#enabled').setValue(false);
        await buttons(wrapper)[0]!.trigger('click');

        expect((wrapper.emitted('create')?.[0]?.[0] as { enabled: number }).enabled).toBe(0);
    });

    it('user is told off when the name is missing', async () => {
        const wrapper = mountDialog();

        await endpointInput(wrapper).setValue('https://api.example.com');
        await buttons(wrapper)[0]!.trigger('click');

        expect(alertErrorMock).toHaveBeenCalledWith('请填写服务商名称和请求地址');
        expect(wrapper.emitted('create')).toBeUndefined();
    });

    it('user is told off when the endpoint is missing', async () => {
        const wrapper = mountDialog();

        await nameInput(wrapper).setValue('Only a name');
        await buttons(wrapper)[0]!.trigger('click');

        expect(alertErrorMock).toHaveBeenCalled();
        expect(wrapper.emitted('create')).toBeUndefined();
    });

    it('user gets the root address previewed once they typed an endpoint', async () => {
        const wrapper = mountDialog();

        expect(wrapper.text()).not.toContain('根地址预览');
        await endpointInput(wrapper).setValue('https://api.example.com/v1');

        expect(wrapper.text()).toContain('根地址预览');
    });

    it('user gets a blank form again the next time the dialog opens', async () => {
        const wrapper = mountDialog();
        await nameInput(wrapper).setValue('Draft name');

        await wrapper.setProps({ open: false });
        await wrapper.setProps({ open: true });

        expect(nameInput(wrapper).element.value).toBe('');
    });

    it('user gets the driver choice reflected in the endpoint placeholder', async () => {
        const wrapper = mountDialog();

        await wrapper.get('[data-testid="driver-select"]').setValue('anthropic');

        const options = wrapper.get('[data-testid="driver-select"]').findAll('option');
        expect(options.length).toBeGreaterThan(1);
        expect(wrapper.emitted('create')).toBeUndefined();
    });
});

describe('user edits an existing provider', () => {
    it('user sees the edit title and the save button', () => {
        const wrapper = mountDialog({ mode: 'edit', provider });

        expect(wrapper.text()).toContain('编辑服务商');
        expect(buttons(wrapper)[0]!.text()).toBe('保存');
    });

    it('user sees the saved name already filled in', () => {
        const wrapper = mountDialog({ mode: 'edit', provider });

        expect(nameInput(wrapper).element.value).toBe('My OpenAI');
    });

    it('user does not see the create-only fields when editing', () => {
        const wrapper = mountDialog({ mode: 'edit', provider });

        expect(wrapper.text()).not.toContain('创建后立即启用');
        expect(wrapper.find('[data-testid="api-key"]').exists()).toBe(false);
        expect(wrapper.find('#enabled').exists()).toBe(false);
    });

    it('user gets only the name sent when saving an edit', async () => {
        const wrapper = mountDialog({ mode: 'edit', provider });

        await nameInput(wrapper).setValue('Renamed provider');
        await buttons(wrapper)[0]!.trigger('click');

        expect(wrapper.emitted('update')?.[0]?.[0]).toMatchObject({
            name: 'Renamed provider',
            driver: 'openai',
        });
    });

    it('user gets the saved root address previewed while editing', () => {
        const wrapper = mountDialog({ mode: 'edit', provider });

        expect(wrapper.text()).toContain('根地址预览');
    });

    it('user is told off when clearing the name of an existing provider', async () => {
        const wrapper = mountDialog({ mode: 'edit', provider });

        await nameInput(wrapper).setValue('   ');
        await buttons(wrapper)[0]!.trigger('click');

        expect(alertErrorMock).toHaveBeenCalledWith('请填写服务商名称');
        expect(wrapper.emitted('update')).toBeUndefined();
    });

    it('user gets the form refilled when the dialog is pointed at another provider', async () => {
        const wrapper = mountDialog({ mode: 'edit', provider });

        await wrapper.setProps({
            provider: { ...provider, id: 9, name: 'Second provider' },
        });

        expect(nameInput(wrapper).element.value).toBe('Second provider');
    });

    it('user gets the name kept when a create dialog receives a provider for some reason', () => {
        const wrapper = mountDialog({ mode: 'create', provider });

        // Create mode always starts blank; the provider prop is an edit-only input.
        expect(nameInput(wrapper).element.value).toBe('');
    });
});

describe('user backs out of the dialog', () => {
    it('user gets the dialog cancelled without saving', async () => {
        const wrapper = mountDialog();
        await nameInput(wrapper).setValue('Half typed');

        await buttons(wrapper)[1]!.trigger('click');

        expect(wrapper.emitted('cancel')).toHaveLength(1);
        expect(wrapper.emitted('create')).toBeUndefined();
    });

    it('user gets the closed event passed on from the dialog shell', async () => {
        const wrapper = mountDialog();

        wrapper.findComponent({ name: 'DialogShell' }).vm.$emit('closed');
        await wrapper.vm.$nextTick();

        expect(wrapper.emitted('closed')).toHaveLength(1);
    });
});
