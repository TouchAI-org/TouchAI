import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BuiltInToolEntity } from '@/app/api/tools/administration';
import { setLocale, t } from '@/i18n';
import BuiltInToolConfig from '@/views/SettingsView/components/BuiltInTools/components/BuiltInToolConfig.vue';

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
        created_at: '',
        updated_at: '',
        ...overrides,
    };
}
let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let wrapper: VueWrapper | undefined;
beforeEach(async () => {
    fixture = await createSettingsPanelFixture();
    setLocale('en-US');
    vi.useFakeTimers();
});
afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.useRealTimers();
    await fixture.dispose();
    document.body.innerHTML = '';
});
function mountPanel(value = tool()) {
    wrapper = mount(BuiltInToolConfig, { ...fixture.viewOptions, props: { tool: value } });
    return wrapper;
}
async function timeout(value: string) {
    await wrapper!.get<HTMLInputElement>('input[type="number"][min="0"]').setValue(value);
}
function savedTimeout() {
    const patch = wrapper!.emitted('save')?.at(-1)?.[0] as { config_json: string };
    return JSON.parse(patch.config_json).timeoutMs;
}

describe('given actual builtin configuration forms and their public save contract', () => {
    it('user edits the timeout and receives its save only after the debounce', async () => {
        mountPanel();
        await timeout('60000');
        expect(wrapper!.emitted('save')).toBeUndefined();
        await vi.advanceTimersByTimeAsync(450);
        expect(savedTimeout()).toBe(60_000);
    });

    it('user edits twice quickly and only the latest complete configuration is saved', async () => {
        mountPanel();
        await timeout('60000');
        await vi.advanceTimersByTimeAsync(200);
        await timeout('30000');
        await vi.advanceTimersByTimeAsync(450);
        expect(wrapper!.emitted('save')).toHaveLength(1);
        expect(savedTimeout()).toBe(30_000);
    });

    it('user restores the original value before saving and no redundant write is requested', async () => {
        mountPanel();
        await timeout('60000');
        await timeout('120000');
        await vi.advanceTimersByTimeAsync(450);
        expect(wrapper!.emitted('save')).toBeUndefined();
    });

    it('user switches tools before saving and a stale timeout cannot overwrite the new tool', async () => {
        mountPanel();
        await timeout('60000');
        await wrapper!.setProps({ tool: tool({ tool_id: 'web_fetch' }) });
        await vi.advanceTimersByTimeAsync(450);
        expect(wrapper!.emitted('save')).toBeUndefined();
    });

    it('user closes before saving and no detached autosave is requested', async () => {
        mountPanel();
        await timeout('60000');
        wrapper!.unmount();
        await vi.advanceTimersByTimeAsync(450);
        expect(wrapper!.emitted('save')).toBeUndefined();
    });

    it('user opens an unconfigured tool and sees that no form is required', () => {
        mountPanel(tool({ tool_id: 'web_fetch' }));
        expect(wrapper!.text()).toContain(t('settings.builtInTools.noConfig'));
    });

    it('user opens an unsupported form and receives the existing coming-soon state', () => {
        mountPanel(tool({ tool_id: 'future-tool' }));
        expect(wrapper!.text()).toContain(t('settings.builtInTools.configComingSoon'));
    });

    it('user opens shell configuration and sees the actual saved timeout control', () => {
        mountPanel();
        expect(wrapper!.get<HTMLInputElement>('input[type="number"][min="0"]').element.value).toBe(
            '120000'
        );
    });

    it('user opens model upgrade configuration and gets its own empty chain rather than shell controls', async () => {
        mountPanel(tool({ tool_id: 'upgrade_model', config_json: '{"chain":[]}' }));
        await flushPromises();
        expect(wrapper!.text()).toContain(t('settings.builtInTools.upgradeModel.emptyChain'));
        expect(wrapper!.find('input[type="number"]').exists()).toBe(false);
    });

    it('user opens conversation search and sees its default-enabled switch', () => {
        mountPanel(
            tool({
                tool_id: 'search_conversation',
                config_json: '{"enabled":true}',
            })
        );

        expect(wrapper!.text()).toContain(t('settings.builtInTools.searchConversation.title'));
        const toggle = wrapper!.get('[data-testid="conversation-search-enabled"]');
        expect(toggle.attributes('data-state')).toBe('checked');
        expect(toggle.attributes('aria-label')).toBe(
            t('settings.builtInTools.searchConversation.title')
        );
    });

    it('user disables conversation search and receives one persisted false value after debounce', async () => {
        mountPanel(
            tool({
                tool_id: 'search_conversation',
                config_json: '{"enabled":true}',
            })
        );
        const toggle = wrapper!.get('[data-testid="conversation-search-enabled"]');
        await toggle.trigger('click');
        await vi.advanceTimersByTimeAsync(450);

        const patch = wrapper!.emitted('save')?.at(-1)?.[0] as { config_json: string };
        expect(JSON.parse(patch.config_json)).toEqual({ enabled: false });
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
