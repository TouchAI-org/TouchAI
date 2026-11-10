import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import BadgedLogo from '@/views/SettingsView/components/AiServices/components/BadgedLogo.vue';
import ImportModeDialog from '@/views/SettingsView/components/DataManagement/components/ImportModeDialog.vue';
import ProgressDialog from '@/views/SettingsView/components/DataManagement/components/ProgressDialog.vue';
import DataManagement from '@/views/SettingsView/components/DataManagement/index.vue';

const {
    alertMock,
    countMessagesMock,
    countSessionsMock,
    countSessionTurnsMock,
    exportDatabaseMock,
    getStatisticMock,
    importDatabaseMock,
    relaunchMock,
} = vi.hoisted(() => ({
    alertMock: {
        error: vi.fn(),
        success: vi.fn(),
    },
    countMessagesMock: vi.fn(),
    countSessionsMock: vi.fn(),
    countSessionTurnsMock: vi.fn(),
    exportDatabaseMock: vi.fn(),
    getStatisticMock: vi.fn(),
    importDatabaseMock: vi.fn(),
    relaunchMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    countMessages: countMessagesMock,
    countSessions: countSessionsMock,
    countSessionTurns: countSessionTurnsMock,
    deleteAllMessages: vi.fn(),
    deleteAllSessions: vi.fn(),
    deleteAllSessionTurns: vi.fn(),
    getStatistic: getStatisticMock,
}));

vi.mock('@database/backup', () => ({
    databaseBackup: {
        exportDatabase: exportDatabaseMock,
        importDatabase: importDatabaseMock,
    },
    isDatabaseBackupCancelledError: (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'DATABASE_BACKUP_CANCELLED',
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => alertMock,
}));

vi.mock('@composables/useConfirm', () => ({
    useConfirm: () => ({
        confirm: vi.fn(),
    }),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
    relaunch: relaunchMock,
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => ({
    updateModelMetadata: vi.fn(),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIcon',
        props: ['name'],
        template: '<span data-testid="app-icon" />',
    },
}));

vi.mock('@components/DialogShell.vue', () => ({
    default: {
        name: 'DialogShell',
        props: ['maxWidthClass', 'contentClass'],
        template:
            '<section data-testid="dialog-shell" :class="[maxWidthClass, contentClass]"><slot /></section>',
    },
}));

vi.mock('@components/ui/button', () => ({
    Button: {
        name: 'Button',
        props: ['variant', 'size'],
        template: '<button><slot /></button>',
    },
}));

vi.mock('@/views/SettingsView/components/DataManagement/components/DiagnosticsSection.vue', () => ({
    default: {
        name: 'SettingsDiagnosticsSection',
        template:
            '<section data-testid="settings-diagnostics-section">Diagnostics and support</section>',
    },
}));

vi.mock('@/views/SettingsView/components/DataManagement/components/AnalyticsSection.vue', () => ({
    default: {
        name: 'SettingsAnalyticsSection',
        template:
            '<section data-testid="settings-analytics-section">Privacy and product analytics</section>',
    },
}));

async function flushMountedPromises() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
    }
}

describe('user manages the app data', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        countSessionsMock.mockResolvedValue(1);
        countMessagesMock.mockResolvedValue(2);
        countSessionTurnsMock.mockResolvedValue(3);
        getStatisticMock.mockResolvedValue('2026-05-20T12:34:00Z');
        importDatabaseMock.mockResolvedValue(true);
    });

    it('user sees model metadata last-updated text in English with localized date formatting', async () => {
        setLocale('en-US');

        const wrapper = mount(DataManagement, {
            global: {
                plugins: [createPinia()],
                stubs: {
                    ImportModeDialog: true,
                    ProgressDialog: true,
                },
            },
        });

        await flushMountedPromises();

        expect(wrapper.text()).toContain('Data & privacy');
        expect(wrapper.text()).toContain('Data statistics');
        expect(wrapper.text()).toContain('Conversation sessions');
        expect(wrapper.text()).toContain('Clear all conversation history');
        expect(wrapper.text()).toContain('Data updates');
        expect(wrapper.text()).toContain('Model database');
        expect(wrapper.text()).toContain('Last updated:');
        expect(wrapper.text()).toContain('Data backup & restore');
        expect(wrapper.text()).toContain('Export backup');
        expect(wrapper.text()).toContain('Import backup');
        expect(wrapper.text()).toContain('Diagnostics and support');
        expect(wrapper.text()).toContain('Privacy and product analytics');
        expect(wrapper.text().indexOf('Diagnostics and support')).toBeLessThan(
            wrapper.text().indexOf('Privacy and product analytics')
        );
        expect(wrapper.text()).toContain('Clear');
        expect(wrapper.text()).toContain('Update');
        expect(wrapper.text()).toContain('Export');
        expect(wrapper.text()).toContain('Import');
        expect(wrapper.text()).toMatch(/May|5/);
        expect(wrapper.text()).not.toContain('最近更新');
        expect(wrapper.text()).not.toContain('数据与隐私');
    });

    it('user keeps the built-in provider badge localized without truncating longer labels', () => {
        setLocale('en-US');

        const wrapper = mount(BadgedLogo, {
            props: {
                logo: 'missing-provider.svg',
                name: 'Built In Provider',
                showBadge: true,
            },
        });

        const badge = wrapper.get('[data-testid="provider-built-in-badge"]');

        expect(badge.text()).toBe('Built-in');
        expect(badge.classes()).toContain('whitespace-nowrap');
        expect(badge.classes()).toContain('min-w-max');
        expect(badge.classes()).not.toContain('truncate');
        expect(badge.classes()).not.toContain('max-w-[4.5rem]');
    });

    it('user sees import mode dialog in English with wrapping-safe option buttons', () => {
        setLocale('en-US');

        const wrapper = mount(ImportModeDialog, {
            props: {
                isLoading: false,
            },
        });

        expect(wrapper.text()).toContain('Choose import mode');
        expect(wrapper.text()).toContain('Import conversation data only');
        expect(wrapper.text()).toContain('Overwrite settings and import conversations');
        expect(wrapper.text()).not.toContain('选择导入模式');

        const modeButtons = wrapper.findAll('button').slice(0, 2);
        expect(modeButtons[0]?.classes()).toContain('whitespace-normal');
        expect(modeButtons[1]?.classes()).toContain('whitespace-normal');
    });

    it('user allows long progress messages and paths to break in the progress dialog', () => {
        const wrapper = mount(ProgressDialog, {
            props: {
                title: 'Database exported',
                message:
                    'E:\\very\\long\\backup\\path\\with\\many\\segments\\touchai-settings-backup-2026-05-22.db',
                progress: 42,
                status: 'success',
                dismissible: true,
            },
        });

        const message = wrapper.get('[data-testid="progress-message"]');

        expect(message.classes()).toContain('break-words');
        expect(message.classes()).toContain('whitespace-normal');
        expect(message.classes()).toContain('[overflow-wrap:anywhere]');
        expect(wrapper.text()).toContain('42%');
    });

    it('user gets a generic export failure without the internal database text', async () => {
        exportDatabaseMock.mockRejectedValueOnce(
            new Error('database is locked while opening /home/user/touchai.db')
        );

        const wrapper = mount(DataManagement, {
            global: {
                stubs: {
                    ImportModeDialog: true,
                    ProgressDialog: true,
                },
            },
        });
        await flushMountedPromises();

        const exportButton = wrapper.findAll('button').find((button) => button.text() === '导出');
        await exportButton?.trigger('click');
        await flushMountedPromises();

        expect(alertMock.error).toHaveBeenCalledWith('导出备份失败');
        expect(alertMock.error).not.toHaveBeenCalledWith(
            expect.stringContaining('database is locked')
        );
        wrapper.unmount();
    });

    it('user gets a generic import failure without the internal database text', async () => {
        importDatabaseMock.mockRejectedValueOnce(
            new Error('database is locked while importing /home/user/backup.db')
        );

        const wrapper = mount(DataManagement, {
            global: {
                stubs: {
                    ImportModeDialog: true,
                    ProgressDialog: true,
                },
            },
        });
        await flushMountedPromises();

        const importButton = wrapper.findAll('button').find((button) => button.text() === '导入');
        await importButton?.trigger('click');
        await wrapper.getComponent(ImportModeDialog).vm.$emit('select', 'full');
        await flushMountedPromises();

        expect(alertMock.error).toHaveBeenCalledWith('导入备份失败');
        expect(alertMock.error).not.toHaveBeenCalledWith(
            expect.stringContaining('database is locked')
        );
        wrapper.unmount();
    });

    it('user starts the restart countdown after the import completes', async () => {
        setLocale('en-US');
        vi.useFakeTimers();

        try {
            const wrapper = mount(DataManagement, {
                global: {
                    stubs: {
                        ProgressDialog: true,
                    },
                },
            });
            await flushMountedPromises();

            const buttons = wrapper.findAll('button');
            await buttons[buttons.length - 1]?.trigger('click');
            await wrapper.getComponent(ImportModeDialog).vm.$emit('select', 'full');
            await flushMountedPromises();

            expect(importDatabaseMock).toHaveBeenCalledWith('full', expect.any(Function));
            expect(relaunchMock).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(4000);
            expect(relaunchMock).toHaveBeenCalledTimes(1);

            vi.clearAllTimers();
            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });
});
