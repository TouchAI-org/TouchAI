import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { setLocale } from '@/i18n';
import BuiltInToolConfig from '@/views/SettingsView/components/BuiltInTools/components/BuiltInToolConfig.vue';
import type { BuiltInToolEntity } from '@/views/SettingsView/components/BuiltInTools/types';

function createTool(patch: Partial<BuiltInToolEntity> = {}): BuiltInToolEntity {
    return {
        id: 1,
        tool_id: 'browser_session',
        display_name: 'Browser Automation',
        description: null,
        enabled: 1,
        risk_level: 'high',
        config_json: null,
        last_used_at: null,
        created_at: '2026-06-03T00:00:00.000Z',
        updated_at: '2026-06-03T00:00:00.000Z',
        ...patch,
    };
}

async function flushAutosave() {
    await nextTick();
    vi.advanceTimersByTime(450);
    await nextTick();
}

function inputValue(wrapper: ReturnType<typeof mount>, selector: string): string {
    return (wrapper.get(selector).element as HTMLInputElement).value;
}

function lastSavePayload(wrapper: ReturnType<typeof mount>): { config_json: string } {
    const saves = wrapper.emitted('save') ?? [];
    return saves[saves.length - 1]?.[0] as { config_json: string };
}

describe('browser automation built-in tool configuration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        setLocale('en-US');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('renders default mode with only the optional startup URL control', () => {
        const wrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({
                    config_json: JSON.stringify({
                        mode: 'default',
                        startupUrl: 'https://example.test/start',
                    }),
                }),
            },
        });

        expect(wrapper.text()).toContain('Browser Automation');
        expect(wrapper.text()).toContain('Default browser');
        expect(inputValue(wrapper, '[data-testid="browser-startup-url"]')).toBe(
            'https://example.test/start'
        );
        expect(wrapper.find('[data-testid="browser-id"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain('Approval policy');
        expect(wrapper.text()).not.toContain('Safety controls');
        expect(wrapper.text()).not.toContain('Allowed hosts');
    });

    it('renders custom launch fields', () => {
        const wrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({
                    tool_id: 'browser_observe',
                    config_json: JSON.stringify({
                        mode: 'custom',
                        browserId: 'chrome',
                        startupUrl: 'https://example.test/custom',
                    }),
                }),
            },
        });

        expect(wrapper.text()).toContain('Specific browser');
        expect(inputValue(wrapper, '[data-testid="browser-id"]')).toBe('chrome');
        expect(inputValue(wrapper, '[data-testid="browser-startup-url"]')).toBe(
            'https://example.test/custom'
        );
    });

    it('emits serialized browser config for shared browser tool rows', async () => {
        const wrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({
                    tool_id: 'browser_act',
                    config_json: JSON.stringify({
                        mode: 'default',
                    }),
                }),
            },
        });

        await wrapper.get('[data-testid="browser-mode-custom"]').trigger('click');
        await wrapper.get('[data-testid="browser-id"]').setValue('  edge  ');
        await wrapper
            .get('[data-testid="browser-startup-url"]')
            .setValue('  https://example.test  ');
        await flushAutosave();

        const emitted = lastSavePayload(wrapper);
        expect(JSON.parse(emitted.config_json)).toEqual({
            mode: 'custom',
            browserId: 'edge',
            startupUrl: 'https://example.test',
        });
    });

    it('disables controls while saving or when the tool is disabled', () => {
        const savingWrapper = mount(BuiltInToolConfig, {
            props: {
                saving: true,
                tool: createTool(),
            },
        });
        const disabledWrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({ enabled: 0 }),
            },
        });

        expect(
            savingWrapper.get('[data-testid="browser-mode-custom"]').attributes()
        ).toHaveProperty('disabled');
        expect(
            disabledWrapper.get('[data-testid="browser-mode-custom"]').attributes()
        ).toHaveProperty('disabled');
    });

    it('validates startup URL locally before saving', async () => {
        const wrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({
                    config_json: JSON.stringify({
                        mode: 'default',
                        startupUrl: 'https://example.test',
                    }),
                }),
            },
        });

        await wrapper.get('[data-testid="browser-startup-url"]').setValue('not a url');
        await flushAutosave();

        expect(wrapper.text()).toContain('Enter a valid http or https URL.');
        expect(wrapper.emitted('save')).toBeUndefined();
    });

    it('cancels pending browser autosave when switching to another tool row', async () => {
        const wrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({
                    tool_id: 'browser_act',
                    config_json: JSON.stringify({
                        mode: 'default',
                        startupUrl: 'https://example.test/start',
                    }),
                }),
            },
        });

        await wrapper
            .get('[data-testid="browser-startup-url"]')
            .setValue('https://example.test/next');
        await nextTick();
        await wrapper.setProps({
            tool: createTool({
                id: 4,
                tool_id: 'bash',
                display_name: 'Bash',
                risk_level: 'medium',
                config_json: JSON.stringify({
                    approvalMode: 'always',
                    defaultWorkingDirectory: '',
                    allowedWorkingDirectories: [],
                    timeoutMs: 12000,
                    maxOutputChars: 16000,
                    compactOutput: true,
                }),
            }),
        });
        await flushAutosave();

        expect(wrapper.emitted('save')).toBeUndefined();
    });

    it('resets invalid and unrelated browser config to defaults on edit', async () => {
        const wrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({
                    config_json: JSON.stringify({
                        mode: 'attached',
                        cdpEndpoint: 'http://127.0.0.1:9222',
                        approvalMode: 'strict',
                        allowedHosts: ['example.test'],
                        browserPath: 'C:\\Browser\\chrome.exe',
                        userDataDir: 'G:\\TouchAI\\browser-profile',
                    }),
                }),
            },
        });

        expect(wrapper.text()).toContain('Default browser');

        await wrapper.get('[data-testid="browser-startup-url"]').setValue('https://example.test');
        await flushAutosave();

        const emitted = lastSavePayload(wrapper);
        expect(JSON.parse(emitted.config_json)).toEqual({
            mode: 'default',
            browserId: '',
            startupUrl: 'https://example.test',
        });
    });

    it('preserves bash config autosave behavior for unrelated tool rows', async () => {
        const wrapper = mount(BuiltInToolConfig, {
            props: {
                tool: createTool({
                    tool_id: 'bash',
                    display_name: 'Bash',
                    config_json: JSON.stringify({
                        approvalMode: 'always',
                        defaultWorkingDirectory: '',
                        allowedWorkingDirectories: [],
                        timeoutMs: 12000,
                        maxOutputChars: 16000,
                        compactOutput: true,
                    }),
                }),
            },
        });

        await wrapper.get('input[type="number"]').setValue('15000');
        await flushAutosave();

        const emitted = lastSavePayload(wrapper);
        expect(JSON.parse(emitted.config_json)).toMatchObject({
            approvalMode: 'always',
            timeoutMs: 15000,
            compactOutput: true,
        });
    });
});
