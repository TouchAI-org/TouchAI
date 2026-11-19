import { createSettingsPanelFixture } from '@tests/utils/settingsPanel';
import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach as beforePresentation } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BashToolConfig } from '@/app/api/tools/configuration';
import { setLocale, t } from '@/i18n';
import BashToolConfigPanel from '@/views/SettingsView/components/BuiltInTools/components/BashToolConfig.vue';

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock }));

const baseConfig: BashToolConfig = {
    approvalMode: 'high_risk',
    defaultWorkingDirectory: '',
    allowedWorkingDirectories: [],
    timeoutMs: 120_000,
    maxOutputChars: 20_000,
    compactOutput: false,
};
let fixture: Awaited<ReturnType<typeof createSettingsPanelFixture>>;
let wrapper: VueWrapper | undefined;

beforeEach(async () => {
    openMock.mockReset();
    fixture = await createSettingsPanelFixture();
    setLocale('en-US');
});
afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await fixture.dispose();
    document.body.innerHTML = '';
});

function mountPanel(config: Partial<BashToolConfig> = {}, disabled = false) {
    wrapper = mount(BashToolConfigPanel, {
        ...fixture.viewOptions,
        props: { modelValue: { ...baseConfig, ...config }, disabled },
    });
    return wrapper;
}
function lastConfig() {
    const events = wrapper!.emitted('update:modelValue');
    expect(events).toBeTruthy();
    const value = events!.at(-1)![0] as BashToolConfig;
    expect(Object.keys(value).sort()).toEqual(Object.keys(baseConfig).sort());
    return value;
}
function picker(index = 0) {
    return wrapper!
        .findAll('button')
        .filter(
            (button) =>
                button.attributes('aria-label') === t('settings.builtInTools.bash.chooseDirectory')
        )[index]!;
}
function addDirectoryButton() {
    return wrapper!.get(`button[aria-label="${t('settings.builtInTools.bash.addDirectory')}"]`);
}
function removeDirectoryButton(index: number) {
    return wrapper!.findAll<HTMLButtonElement>(
        `button[aria-label="${t('settings.builtInTools.bash.removeDirectory')}"]`
    )[index]!.element;
}

describe('given the real builtin configuration controls and a settings-only native picker', () => {
    it('user changes approval mode and receives a complete configuration without changing other fields', async () => {
        mountPanel();
        await wrapper!
            .findAll('button')
            .find((button) => button.text() === 'Full access')!
            .trigger('click');
        expect(lastConfig()).toEqual({ ...baseConfig, approvalMode: 'never' });
    });

    it('user picks a default working directory and receives the selected path', async () => {
        openMock.mockResolvedValue('C:/work/project');
        mountPanel();
        await picker().trigger('click');
        await flushPromises();
        expect(lastConfig().defaultWorkingDirectory).toBe('C:/work/project');
    });

    it('user cancels the native directory picker and keeps the existing configuration', async () => {
        openMock.mockResolvedValue(null);
        mountPanel({ defaultWorkingDirectory: 'C:/existing' });
        await picker().trigger('click');
        await flushPromises();
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
        expect(wrapper!.get<HTMLInputElement>('input[readonly]').element.value).toBe('C:/existing');
    });

    it('user keeps the directory after a picker failure and can choose it successfully afterward', async () => {
        openMock.mockRejectedValueOnce(new Error('fixture dialog unavailable'));
        mountPanel({ defaultWorkingDirectory: 'C:/existing' });
        await picker().trigger('click');
        await flushPromises();
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
        openMock.mockResolvedValue('C:/following');
        await picker().trigger('click');
        await flushPromises();
        expect(lastConfig().defaultWorkingDirectory).toBe('C:/following');
    });

    it('user adds an allowed directory without losing an existing entry', async () => {
        openMock.mockResolvedValue('C:/work/allowed');
        mountPanel({ allowedWorkingDirectories: ['C:/work/first'] });
        await addDirectoryButton().trigger('click');
        await flushPromises();
        expect(lastConfig().allowedWorkingDirectories).toEqual([
            'C:/work/first',
            'C:/work/allowed',
        ]);
    });

    it('user picks an existing allowed directory without duplicating it', async () => {
        openMock.mockResolvedValue('C:/work/first');
        mountPanel({ allowedWorkingDirectories: ['C:/work/first'] });
        await addDirectoryButton().trigger('click');
        await flushPromises();
        expect(lastConfig().allowedWorkingDirectories).toEqual(['C:/work/first']);
    });

    it('user removes one allowed directory and keeps the other entry', async () => {
        mountPanel({ allowedWorkingDirectories: ['C:/work/first', 'C:/work/second'] });
        removeDirectoryButton(0).click();
        await flushPromises();
        expect(lastConfig().allowedWorkingDirectories).toEqual(['C:/work/second']);
    });

    it('user replaces an allowed directory through the native picker', async () => {
        openMock.mockResolvedValue('C:/work/replacement');
        mountPanel({ allowedWorkingDirectories: ['C:/work/first'] });
        await picker(1).trigger('click');
        await flushPromises();
        expect(lastConfig().allowedWorkingDirectories).toEqual(['C:/work/replacement']);
    });

    it('user enables compact output through the actual switch', async () => {
        mountPanel();
        await wrapper!.get('[role="switch"]').trigger('click');
        expect(lastConfig().compactOutput).toBe(true);
    });

    it('user sees the configured directories and both current limits', () => {
        mountPanel({
            defaultWorkingDirectory: 'C:/work/project',
            allowedWorkingDirectories: ['C:/work/allowed'],
        });
        expect(wrapper!.findAll('input').map((input) => input.element.value)).toEqual([
            'C:/work/project',
            'C:/work/allowed',
            '120000',
            '20000',
        ]);
        expect(wrapper!.get('[role="switch"]').attributes('aria-checked')).toBe('false');
    });

    it('user clears a timeout field without unintentionally disabling the current timeout', async () => {
        mountPanel();
        await wrapper!.findAll('input[type="number"]')[0]!.setValue('');
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });

    it('user explicitly chooses no timeout or edits the output limit and other fields stay unchanged', async () => {
        mountPanel();
        await wrapper!.findAll('input[type="number"]')[0]!.setValue('0');
        expect(lastConfig()).toEqual({ ...baseConfig, timeoutMs: 0 });
        await wrapper!.findAll('input[type="number"]')[1]!.setValue('10000');
        expect(lastConfig()).toEqual({ ...baseConfig, maxOutputChars: 10000 });
    });

    it('user cannot change a disabled configuration or open its directory picker', async () => {
        mountPanel({}, true);
        expect(wrapper!.findAll('button').every((button) => button.element.disabled)).toBe(true);
        await picker().trigger('click');
        expect(openMock).not.toHaveBeenCalled();
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });

    it('user closes the panel while a picker is open and its late path cannot edit a detached configuration', async () => {
        let finish!: (path: string) => void;
        openMock.mockImplementation(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                })
        );
        mountPanel();
        await picker().trigger('click');
        wrapper!.unmount();
        finish('C:/late');
        await flushPromises();
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });

    it('user disables the panel while a picker is open and its late path cannot edit the disabled configuration', async () => {
        let finish!: (path: string) => void;
        openMock.mockImplementation(
            () =>
                new Promise<string>((resolve) => {
                    finish = resolve;
                })
        );
        mountPanel();
        await picker().trigger('click');
        await wrapper!.setProps({ disabled: true });
        finish('C:/late');
        await flushPromises();
        expect(wrapper!.emitted('update:modelValue')).toBeUndefined();
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
