// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import DiagnosticsSection from '@/views/SettingsView/components/General/DiagnosticsSection.vue';

enableAutoUnmount(afterEach);

const mocks = vi.hoisted(() => ({
    preview: {
        files: [
            { name: 'logs/TouchAI.log', bytes: 2048 },
            { name: 'crashes/20261028T031502Z-7f3a9c.txt', bytes: 512 },
        ],
        totalBytes: 2560,
        logDirectoryFallback: false,
    },
    status: { enabled: false, expiresAtMs: 0 },
    setDiagnosticMode: vi.fn(async (enabled: boolean) => ({
        enabled,
        expiresAtMs: enabled ? Date.now() + 30 * 60 * 1000 : 0,
    })),
    diagnosticModeStatus: vi.fn(),
    previewBundle: vi.fn(),
    exportBundle: vi.fn(),
    dismissCrashes: vi.fn(),
    save: vi.fn(),
    confirm: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
}));

vi.mock('@services/NativeService', () => ({
    native: {
        observability: {
            setDiagnosticMode: mocks.setDiagnosticMode,
            diagnosticModeStatus: mocks.diagnosticModeStatus,
            previewBundle: mocks.previewBundle,
            exportBundle: mocks.exportBundle,
            dismissCrashes: mocks.dismissCrashes,
        },
    },
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
    save: mocks.save,
}));

vi.mock('@composables/useConfirm', () => ({
    useConfirm: () => ({ confirm: mocks.confirm }),
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({ success: mocks.success, error: mocks.error }),
}));

vi.mock('@components/SettingsRow.vue', () => ({
    default: {
        props: ['label'],
        template: '<div><span>{{ label }}</span><slot /></div>',
    },
}));

vi.mock('@components/ui/button', () => ({
    Button: {
        emits: ['click'],
        template: '<button v-bind="$attrs" @click="$emit(\'click\')"><slot /></button>',
    },
}));

vi.mock('@components/ui/switch', () => ({
    Switch: {
        props: ['modelValue'],
        emits: ['update:modelValue'],
        template:
            '<button data-testid="diagnostic-switch" @click="$emit(\'update:modelValue\', !modelValue)" />',
    },
}));

describe('user exports and controls diagnostics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('en-US');
        mocks.diagnosticModeStatus.mockResolvedValue(mocks.status);
        mocks.previewBundle.mockResolvedValue(mocks.preview);
        mocks.exportBundle.mockResolvedValue(mocks.preview);
        mocks.dismissCrashes.mockResolvedValue(1);
        mocks.confirm.mockResolvedValue(true);
        mocks.save.mockResolvedValue('/tmp/TouchAI-diagnostics.zip');
    });

    afterEach(() => {
        setLocale('zh-CN');
        document.body.innerHTML = '';
    });

    it('user sees crash records and can dismiss them', async () => {
        const wrapper = mount(DiagnosticsSection);
        await flushPromises();

        expect(wrapper.text()).toContain('1 records');
        const dismiss = wrapper.findAll('button').find((button) => button.text() === 'Dismiss');
        await dismiss!.trigger('click');
        await flushPromises();

        expect(mocks.dismissCrashes).toHaveBeenCalledOnce();
        expect(mocks.previewBundle).toHaveBeenCalledTimes(2);
    });

    it('user receives a time-limited debug mode toggle', async () => {
        const wrapper = mount(DiagnosticsSection);
        await flushPromises();

        await wrapper.get('[data-testid="diagnostic-switch"]').trigger('click');
        await flushPromises();

        expect(mocks.setDiagnosticMode).toHaveBeenCalledWith(true);
        expect(wrapper.text()).toMatch(/(29|30):\d{2}/);
    });

    it('user confirms the file list before exporting diagnostics', async () => {
        const wrapper = mount(DiagnosticsSection);
        await flushPromises();

        const exportButton = wrapper
            .findAll('button')
            .find((button) => button.text() === 'Export diagnostics');
        await exportButton!.trigger('click');
        await flushPromises();

        expect(mocks.confirm).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('2 files'),
            })
        );
        expect(mocks.save).toHaveBeenCalledOnce();
        expect(mocks.exportBundle).toHaveBeenCalledWith('/tmp/TouchAI-diagnostics.zip');
        expect(mocks.success).toHaveBeenCalled();
    });
});
