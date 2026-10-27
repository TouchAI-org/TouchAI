import { log } from '@services/ObservabilityService';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import BashToolConfigPanel from '@/views/SettingsView/components/BuiltInTools/components/BashToolConfig.vue';

/**
 * These settings decide what the built-in Bash tool is allowed to touch. A change that is not
 * emitted leaves the store holding the old value, so the user's next command runs under rules
 * they thought they had changed.
 */
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock }));

const baseConfig = {
    approvalMode: 'high_risk' as const,
    defaultWorkingDirectory: '',
    allowedWorkingDirectories: [] as string[],
    timeoutMs: 120_000,
    maxOutputChars: 20_000,
    compactOutput: false,
};

function mountPanel(config = {}) {
    return mount(BashToolConfigPanel, {
        props: { modelValue: { ...baseConfig, ...config } },
        global: {
            stubs: {
                AppIcon: { props: ['name'], template: '<i :data-icon="name" />' },
                Input: {
                    props: ['modelValue', 'type'],
                    emits: ['update:modelValue', 'input'],
                    template:
                        '<input :type="type" :value="modelValue" @input="$emit(\'input\', $event)" />',
                },
                Switch: {
                    props: ['checked'],
                    emits: ['update:checked', 'change'],
                    template:
                        '<button role="switch" :aria-checked="checked" @click="$emit(\'change\', !checked)" />',
                },
            },
        },
    });
}

function lastConfig(wrapper: ReturnType<typeof mountPanel>) {
    const events = wrapper.emitted('update:modelValue');
    expect(events, 'no update was emitted').toBeTruthy();
    const payload = events![events!.length - 1]![0];
    // The parent replaces its whole config with this payload, so it must carry every field.
    expect(Object.keys(payload as object).sort()).toEqual(Object.keys(baseConfig).sort());
    return payload as typeof baseConfig;
}

/** The picker button for the default directory carries the folder-open icon. */
function defaultDirectoryButton(wrapper: ReturnType<typeof mountPanel>) {
    return wrapper
        .findAll('button')
        .find((button) => button.find('[data-icon="folder-open"]').exists())!;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('user configures the built-in bash tool', () => {
    it('user changes the approval mode and the new mode is emitted', async () => {
        const wrapper = mountPanel();
        // Select by the label the user reads, not by position.
        const option = wrapper.findAll('button').find((button) => button.text() === '完全访问');
        expect(option, 'the full-access approval option should be rendered').toBeTruthy();

        await option!.trigger('click');

        expect(lastConfig(wrapper).approvalMode).toBe('never');
        wrapper.unmount();
    });

    it('user picks a default working directory and it is emitted', async () => {
        openMock.mockResolvedValue('C:/work/project');
        const wrapper = mountPanel();

        await defaultDirectoryButton(wrapper).trigger('click');
        await Promise.resolve();
        await Promise.resolve();

        expect(lastConfig(wrapper).defaultWorkingDirectory).toBe('C:/work/project');
        wrapper.unmount();
    });

    it('user cancels the directory picker and nothing is emitted', async () => {
        openMock.mockResolvedValue(null);
        const wrapper = mountPanel();

        await defaultDirectoryButton(wrapper).trigger('click');
        await Promise.resolve();
        await Promise.resolve();

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        wrapper.unmount();
    });

    it('user gets an error from the picker swallowed and nothing changed', async () => {
        openMock.mockRejectedValue(new Error('dialog unavailable'));
        const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
        const wrapper = mountPanel();

        await defaultDirectoryButton(wrapper).trigger('click');
        await Promise.resolve();
        await Promise.resolve();

        expect(wrapper.emitted('update:modelValue')).toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
        wrapper.unmount();
    });

    it('user adds an allowed directory and it joins the list', async () => {
        openMock.mockResolvedValue('C:/work/allowed');
        const wrapper = mountPanel({ allowedWorkingDirectories: ['C:/work/first'] });

        await wrapper
            .find('[data-icon="plus"]')
            .element.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();

        expect(lastConfig(wrapper).allowedWorkingDirectories).toEqual([
            'C:/work/first',
            'C:/work/allowed',
        ]);
        wrapper.unmount();
    });

    it('user adds the same directory twice and it is not duplicated', async () => {
        openMock.mockResolvedValue('C:/work/first');
        const wrapper = mountPanel({ allowedWorkingDirectories: ['C:/work/first'] });

        await wrapper
            .find('[data-icon="plus"]')
            .element.parentElement!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
        await Promise.resolve();

        // A duplicate would make the list grow every time the user re-picks.
        expect(lastConfig(wrapper).allowedWorkingDirectories).toEqual(['C:/work/first']);
        wrapper.unmount();
    });

    it('user removes an allowed directory and it leaves the list', async () => {
        const wrapper = mountPanel({
            allowedWorkingDirectories: ['C:/work/first', 'C:/work/second'],
        });

        const removeButtons = wrapper
            .findAll('button')
            .filter((button) => button.find('[data-icon="x"]').exists());
        await removeButtons[0]!.trigger('click');

        expect(lastConfig(wrapper).allowedWorkingDirectories).toEqual(['C:/work/second']);
        wrapper.unmount();
    });

    it('user picks a replacement for an allowed directory and the entry changes', async () => {
        openMock.mockResolvedValue('C:/work/replacement');
        const wrapper = mountPanel({ allowedWorkingDirectories: ['C:/work/first'] });

        const pickButtons = wrapper
            .findAll('button')
            .filter((button) => button.find('[data-icon="folder-open"]').exists());
        // The last folder button belongs to the allowed-directory row.
        await pickButtons[pickButtons.length - 1]!.trigger('click');
        await Promise.resolve();
        await Promise.resolve();

        expect(lastConfig(wrapper).allowedWorkingDirectories).toEqual(['C:/work/replacement']);
        wrapper.unmount();
    });

    it('user turns compact output on and the flag is emitted', async () => {
        const wrapper = mountPanel();

        await wrapper.find('[role="switch"]').trigger('click');

        expect(lastConfig(wrapper).compactOutput).toBe(true);
        wrapper.unmount();
    });

    it('user sees the directories and limits the tool is using', () => {
        const wrapper = mountPanel({
            defaultWorkingDirectory: 'C:/work/project',
            allowedWorkingDirectories: ['C:/work/allowed'],
        });

        // The panel has to show the current values, or the user cannot tell what is set.
        const values = wrapper.findAll('input').map((input) => input.element.value);
        expect(values).toContain('C:/work/project');
        expect(values).toContain('C:/work/allowed');
        // The limits are shown, not just rendered as some inputs.
        const shown = wrapper.findAll('input').map((input) => input.element.value);
        expect(shown).toContain('120000');
        expect(shown).toContain('20000');
        expect(wrapper.findAll('input')).toHaveLength(4);
        expect(wrapper.find('[role="switch"]').exists()).toBe(true);
        wrapper.unmount();
    });
});
