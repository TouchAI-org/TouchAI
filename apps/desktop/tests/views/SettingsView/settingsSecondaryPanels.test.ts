import { mount, shallowMount } from '@vue/test-utils';
import { vi } from 'vitest';

import ProviderList from '@/views/SettingsView/components/AiServices/components/ProviderList.vue';
import BuiltInToolsSection from '@/views/SettingsView/components/BuiltInTools/index.vue';
import McpToolsSection from '@/views/SettingsView/components/McpTools/index.vue';

const builtInToolQueriesMock = vi.hoisted(() => ({
    findAllBuiltInTools: vi.fn().mockResolvedValue([
        {
            id: 1,
            tool_id: 'bash',
            display_name: 'Bash',
            description: 'Shell',
            enabled: 1,
            risk_level: 'high',
            config_json: null,
            last_used_at: null,
            created_at: '',
            updated_at: '',
        },
    ]),
    updateBuiltInTool: vi.fn(),
    findBuiltInToolLogsByToolId: vi.fn(),
}));

const mcpStoreMock = vi.hoisted(() => ({
    initialized: true,
    loading: false,
    servers: [],
    loadServers: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    serverById: vi.fn(),
    getServerStatus: vi.fn(() => 'disconnected'),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@/views/SettingsView/components/BuiltInTools/types', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('@/views/SettingsView/components/BuiltInTools/types')>();

    return {
        ...actual,
        loadBuiltInToolQueries: vi.fn().mockResolvedValue(builtInToolQueriesMock),
    };
});

vi.mock('@/stores/mcp', () => ({
    useMcpStore: () => mcpStoreMock,
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        connectServer: vi.fn(),
        disconnectServer: vi.fn(),
    },
}));

vi.mock('@database/queries', () => ({
    deleteMcpServer: vi.fn(),
    updateMcpServer: vi.fn(),
}));

vi.mock('@composables/useContextMenu.ts', () => ({
    useContextMenu: () => ({ open: vi.fn() }),
}));

vi.mock('@composables/useScrollbarStabilizer', () => ({
    useScrollbarStabilizer: vi.fn(),
}));

vi.mock('@components/AlertMessage.vue', () => ({
    default: {
        name: 'AlertMessageStub',
        template: '<div />',
        methods: {
            error: vi.fn(),
            success: vi.fn(),
        },
    },
}));

describe('settings secondary panels', () => {
    beforeEach(() => {
        builtInToolQueriesMock.findAllBuiltInTools.mockClear();
        mcpStoreMock.loadServers.mockClear();
        mcpStoreMock.initialize.mockClear();
    });

    it('lets the provider list panel resize and omits redundant local headers', async () => {
        const wrapper = mount(ProviderList, {
            props: {
                providers: [
                    {
                        id: 1,
                        name: 'mimo',
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
                ],
                selectedProviderId: 1,
                defaultModelProviderIds: new Set([1]),
            },
            global: {
                stubs: {
                    ProviderCard: {
                        props: ['provider'],
                        template: '<button>{{ provider.name }}</button>',
                    },
                },
            },
        });

        expect(wrapper.text()).not.toContain('服务商与模型');
        expect(wrapper.text()).not.toContain('PROVIDERS');
        expect(wrapper.text()).not.toContain('Provider、API Key');

        const panel = wrapper.get('[data-testid="settings-ai-services-panel"]');
        const resizer = wrapper.get('[data-testid="settings-ai-services-panel-resizer"]');
        expect(panel.attributes('data-settings-secondary-panel')).toBe('true');
        expect(resizer.attributes('tabindex')).toBe('0');
        expect(resizer.attributes('aria-valuemin')).toBe('248');
        expect(resizer.attributes('aria-valuemax')).toBe('336');

        const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true });
        Object.defineProperty(pointerDown, 'button', { value: 0 });
        Object.defineProperty(pointerDown, 'clientX', { value: 260 });

        resizer.element.dispatchEvent(pointerDown);
        const pointerMove = new Event('pointermove', { bubbles: true, cancelable: true });
        Object.defineProperty(pointerMove, 'clientX', { value: 300 });
        window.dispatchEvent(pointerMove);
        await wrapper.vm.$nextTick();

        expect(panel.attributes('style')).toContain('width: 304px');

        await resizer.trigger('keydown', { key: 'ArrowLeft' });

        expect(panel.attributes('style')).toContain('width: 288px');
    });

    it('forwards provider list item and footer actions', async () => {
        const wrapper = mount(ProviderList, {
            props: {
                providers: [
                    {
                        id: 7,
                        name: 'mimo',
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
                ],
                selectedProviderId: 7,
                defaultModelProviderIds: new Set([7]),
            },
            global: {
                stubs: {
                    ProviderCard: {
                        props: ['provider'],
                        emits: ['select', 'toggle-enabled', 'validation-error', 'context-menu'],
                        template: `
                            <button
                                data-testid="provider-card"
                                @click="$emit('select')"
                                @dblclick="$emit('toggle-enabled')"
                                @keydown.enter="$emit('validation-error', 'missing endpoint')"
                                @contextmenu="$emit('context-menu', $event)"
                            >
                                {{ provider.name }}
                            </button>
                        `,
                    },
                },
            },
        });

        await wrapper.get('[data-testid="provider-card"]').trigger('click');
        await wrapper.get('[data-testid="provider-card"]').trigger('dblclick');
        await wrapper.get('[data-testid="provider-card"]').trigger('keydown.enter');
        await wrapper.get('[data-testid="provider-card"]').trigger('contextmenu');
        await wrapper.get('[data-testid="settings-add-custom-provider-button"]').trigger('click');

        expect(wrapper.emitted('select')?.[0]).toEqual([7]);
        expect(wrapper.emitted('toggle-enabled')?.[0]).toEqual([7]);
        expect(wrapper.emitted('validation-error')?.[0]).toEqual(['missing endpoint']);
        expect(wrapper.emitted('context-menu')?.[0]?.[0]).toBe(7);
        expect(wrapper.emitted('context-menu')?.[0]?.[1]).toBeInstanceOf(MouseEvent);
        expect(wrapper.emitted('add-custom')).toHaveLength(1);
    });

    it('mounts resizable built-in tools and MCP secondary panels without redundant local headers', () => {
        const builtInWrapper = shallowMount(BuiltInToolsSection, {
            global: {
                stubs: {
                    BuiltInToolList: true,
                    SectionTabs: true,
                    BuiltInToolConfig: true,
                    BuiltInToolLogViewer: true,
                },
            },
        });
        const mcpWrapper = shallowMount(McpToolsSection, {
            global: {
                stubs: {
                    McpServerList: true,
                    SectionTabs: true,
                    McpServerConfig: true,
                    McpToolList: true,
                    McpToolLogViewer: true,
                },
            },
        });

        expect(builtInWrapper.find('[data-testid="settings-built-in-tools-panel"]').exists()).toBe(
            true
        );
        expect(
            builtInWrapper.find('[data-testid="settings-built-in-tools-panel-resizer"]').exists()
        ).toBe(true);
        expect(
            builtInWrapper.get('[data-testid="settings-built-in-tools-panel"]').find('h2').exists()
        ).toBe(false);
        expect(builtInWrapper.text()).not.toContain('TOOLS');
        expect(builtInWrapper.text()).not.toContain('控制应用内建工具');

        expect(mcpWrapper.find('[data-testid="settings-mcp-tools-panel"]').exists()).toBe(true);
        expect(mcpWrapper.find('[data-testid="settings-mcp-tools-panel-resizer"]').exists()).toBe(
            true
        );
        expect(mcpWrapper.get('[data-testid="settings-mcp-tools-panel"]').find('h2').exists()).toBe(
            false
        );
        expect(mcpWrapper.text()).not.toContain('管理外部工具服务器');
    });
});
