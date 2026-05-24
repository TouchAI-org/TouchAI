import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MetaKey } from '@/database/schema';
import { setLocale } from '@/i18n';
import BadgedLogo from '@/views/SettingsView/components/AiServices/components/BadgedLogo.vue';
import ImportModeDialog from '@/views/SettingsView/components/DataManagement/components/ImportModeDialog.vue';
import ProgressDialog from '@/views/SettingsView/components/DataManagement/components/ProgressDialog.vue';
import DataManagement from '@/views/SettingsView/components/DataManagement/index.vue';

const {
    countMessagesMock,
    countSessionsMock,
    countSessionTurnsMock,
    getStatisticMock,
    importDatabaseMock,
    relaunchMock,
    setMetaMock,
} = vi.hoisted(() => ({
    countMessagesMock: vi.fn(),
    countSessionsMock: vi.fn(),
    countSessionTurnsMock: vi.fn(),
    getStatisticMock: vi.fn(),
    importDatabaseMock: vi.fn(),
    relaunchMock: vi.fn(),
    setMetaMock: vi.fn(),
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

vi.mock('@database/queries/touchaiMeta', () => ({
    setMeta: setMetaMock,
}));

vi.mock('@database/backup', () => ({
    databaseBackup: {
        exportDatabase: vi.fn(),
        importDatabase: importDatabaseMock,
    },
    isDatabaseBackupCancelledError: (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        (error as { code?: unknown }).code === 'DATABASE_BACKUP_CANCELLED',
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({
        error: vi.fn(),
        success: vi.fn(),
    }),
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

async function flushMountedPromises() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
    }
}

describe('Settings data management i18n and layout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        countSessionsMock.mockResolvedValue(1);
        countMessagesMock.mockResolvedValue(2);
        countSessionTurnsMock.mockResolvedValue(3);
        getStatisticMock.mockResolvedValue('2026-05-20T12:34:00Z');
        importDatabaseMock.mockResolvedValue({
            sourcePath: 'D:/backup.db',
            importMode: 'full',
            currentBackupPath: '',
            sourceBackupPath: null,
            migratedSource: false,
        });
        setMetaMock.mockResolvedValue(undefined);
    });

    it('renders model metadata last-updated text in English with localized date formatting', async () => {
        setLocale('en-US');

        const wrapper = mount(DataManagement, {
            global: {
                stubs: {
                    ImportModeDialog: true,
                    ProgressDialog: true,
                },
            },
        });

        await flushMountedPromises();

        expect(wrapper.text()).toContain('Data management');
        expect(wrapper.text()).toContain('Manage application data and settings backups');
        expect(wrapper.text()).toContain('Data statistics');
        expect(wrapper.text()).toContain('Conversation sessions');
        expect(wrapper.text()).toContain('Clear all conversation history');
        expect(wrapper.text()).toContain('Data updates');
        expect(wrapper.text()).toContain('Model database');
        expect(wrapper.text()).toContain('Last updated:');
        expect(wrapper.text()).toContain('Settings backup');
        expect(wrapper.text()).toContain('Export settings');
        expect(wrapper.text()).toContain('Import settings');
        expect(wrapper.text()).toContain('Clear');
        expect(wrapper.text()).toContain('Update');
        expect(wrapper.text()).toContain('Export');
        expect(wrapper.text()).toContain('Import');
        expect(wrapper.text()).toMatch(/May|5/);
        expect(wrapper.text()).not.toContain('最近更新');
        expect(wrapper.text()).not.toContain('数据管理');
    });

    it('keeps the built-in provider badge localized without truncating longer labels', () => {
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

    it('renders import mode dialog in English with wrapping-safe option buttons', () => {
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

    it('allows long progress messages and paths to break in the progress dialog', () => {
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
        expect(message.classes()).toContain('overflow-wrap-anywhere');
        expect(wrapper.text()).toContain('42%');
    });

    it('persists import-success startup notification as a source payload instead of translated text', async () => {
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

            expect(setMetaMock).toHaveBeenCalledWith({
                key: MetaKey.IMPORT_SUCCESS,
                value: JSON.stringify({
                    type: 'import-success',
                    version: 1,
                    importMode: 'full',
                }),
            });
            expect(JSON.stringify(setMetaMock.mock.calls)).not.toContain(
                'Data imported successfully'
            );

            vi.clearAllTimers();
            wrapper.unmount();
        } finally {
            vi.useRealTimers();
        }
    });
});
