import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BuiltInToolConfig from '@/views/SettingsView/components/BuiltInTools/components/BuiltInToolConfig.vue';
import type { BuiltInToolEntity } from '@/views/SettingsView/components/BuiltInTools/types';

/**
 * The panel saves by itself 450 ms after the last edit. A timer that fires with stale config
 * overwrites what the user just typed; a timer that never fires loses the edit entirely.
 */
const bashConfig = {
    approvalMode: 'high_risk',
    defaultWorkingDirectory: '',
    allowedWorkingDirectories: [],
    timeoutMs: 120_000,
    maxOutputChars: 20_000,
    compactOutput: false,
};

function tool(overrides: Partial<BuiltInToolEntity> = {}): BuiltInToolEntity {
    return {
        id: 1,
        tool_id: 'bash',
        display_name: 'Bash',
        description: null,
        enabled: 1,
        risk_level: 'medium',
        config_json: JSON.stringify(bashConfig),
        last_used_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

function mountPanel(props: { tool?: BuiltInToolEntity; saving?: boolean } = {}) {
    return mount(BuiltInToolConfig, {
        props: { tool: tool(), ...props },
        global: {
            stubs: {
                BashToolConfig: {
                    name: 'BashToolConfig',
                    props: ['modelValue'],
                    emits: ['update:modelValue'],
                    template: '<div data-config="bash" />',
                },
                UpgradeModelToolConfig: {
                    name: 'UpgradeModelToolConfig',
                    props: ['modelValue'],
                    emits: ['update:modelValue'],
                    template: '<div data-config="upgrade-model" />',
                },
                EmptyState: {
                    props: ['title'],
                    template: '<div data-empty="true">{{ title }}</div>',
                },
            },
        },
    });
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('user edits a built-in tool setting', () => {
    it('user edits the bash config and the change is saved after the debounce', async () => {
        const wrapper = mountPanel();

        wrapper
            .findComponent({ name: 'BashToolConfig' })
            .vm.$emit('update:modelValue', { ...bashConfig, timeoutMs: 60_000 });
        await wrapper.vm.$nextTick();

        // Nothing is written while the user is still typing.
        expect(wrapper.emitted('save')).toBeUndefined();

        vi.advanceTimersByTime(450);

        expect(wrapper.emitted('save')).toHaveLength(1);
        expect((wrapper.emitted('save')![0]![0] as { config_json: string }).config_json).toContain(
            '60000'
        );
        wrapper.unmount();
    });

    it('user edits twice quickly and only the last value is saved', async () => {
        const wrapper = mountPanel();
        const panel = wrapper.findComponent({ name: 'BashToolConfig' });

        panel.vm.$emit('update:modelValue', { ...bashConfig, timeoutMs: 60_000 });
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(200);
        panel.vm.$emit('update:modelValue', { ...bashConfig, timeoutMs: 30_000 });
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(450);

        // A save per keystroke would write stale config over the newer value.
        expect(wrapper.emitted('save')).toHaveLength(1);
        expect((wrapper.emitted('save')![0]![0] as { config_json: string }).config_json).toContain(
            '30000'
        );
        wrapper.unmount();
    });

    it('user gets no save when the config ends up unchanged', async () => {
        const wrapper = mountPanel();

        // Emitting the same value back must not look like an edit.
        wrapper.findComponent({ name: 'BashToolConfig' }).vm.$emit('update:modelValue', bashConfig);
        await wrapper.vm.$nextTick();
        vi.advanceTimersByTime(450);

        expect(wrapper.emitted('save')).toBeUndefined();
        wrapper.unmount();
    });

    it('user switches to another tool and no stale save fires', async () => {
        const wrapper = mountPanel();
        wrapper
            .findComponent({ name: 'BashToolConfig' })
            .vm.$emit('update:modelValue', { ...bashConfig, timeoutMs: 60_000 });
        await wrapper.vm.$nextTick();

        await wrapper.setProps({ tool: tool({ tool_id: 'web_fetch' }) });
        vi.advanceTimersByTime(450);

        // A save from the previous tool would write bash config onto another tool.
        expect(wrapper.emitted('save')).toBeUndefined();
        wrapper.unmount();
    });

    it('user closes the panel before the debounce and nothing is saved', async () => {
        const wrapper = mountPanel();
        wrapper
            .findComponent({ name: 'BashToolConfig' })
            .vm.$emit('update:modelValue', { ...bashConfig, timeoutMs: 60_000 });
        await wrapper.vm.$nextTick();

        wrapper.unmount();
        vi.advanceTimersByTime(450);

        // A timer surviving unmount writes to a component that no longer exists.
        expect(wrapper.emitted('save')).toBeUndefined();
    });

    it('user opens a tool with no config and sees the no-config message', () => {
        const wrapper = mountPanel({ tool: tool({ tool_id: 'web_fetch' }) });

        // The two empty states say different things, so the message itself is asserted.
        expect(wrapper.find('[data-empty="true"]').text()).toBe('该工具无需在此配置');
        wrapper.unmount();
    });

    it('user opens a tool whose config is not built yet and sees that message', () => {
        const wrapper = mountPanel({ tool: tool({ tool_id: 'some_future_tool' }) });

        expect(wrapper.find('[data-empty="true"]').text()).toBe(
            '该工具的配置表单将在后续批次接入。'
        );
        wrapper.unmount();
    });

    it('user opens the bash tool and gets the bash panel', () => {
        const wrapper = mountPanel();

        expect(wrapper.find('[data-config="bash"]').exists()).toBe(true);
        wrapper.unmount();
    });

    it('user opens the upgrade-model tool and gets its own panel', () => {
        const wrapper = mountPanel({ tool: tool({ tool_id: 'upgrade_model' }) });

        expect(wrapper.find('[data-config="upgrade-model"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
