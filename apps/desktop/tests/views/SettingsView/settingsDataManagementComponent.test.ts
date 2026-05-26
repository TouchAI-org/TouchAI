import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, vi } from 'vitest';

import DataManagementSection from '@/views/SettingsView/components/DataManagement/index.vue';

const queriesMock = vi.hoisted(() => ({
    countSessions: vi.fn().mockResolvedValue(0),
    countMessages: vi.fn().mockResolvedValue(0),
    countSessionTurns: vi.fn().mockResolvedValue(0),
    deleteAllSessions: vi.fn(),
    deleteAllMessages: vi.fn(),
    deleteAllSessionTurns: vi.fn(),
    getStatistic: vi.fn().mockResolvedValue(null),
}));

vi.mock('@components/AppIcon.vue', () => ({
    default: {
        name: 'AppIconStub',
        props: ['name'],
        template: '<span data-testid="app-icon" :data-name="name" />',
    },
}));

vi.mock('@composables/useAlert', () => ({
    useAlert: () => ({
        success: vi.fn(),
        error: vi.fn(),
    }),
}));

vi.mock('@composables/useConfirm', () => ({
    useConfirm: () => ({
        confirm: vi.fn().mockResolvedValue(false),
    }),
}));

vi.mock('@database/backup', () => ({
    databaseBackup: {
        exportDatabase: vi.fn(),
        importDatabase: vi.fn(),
    },
}));

vi.mock('@database/queries', () => queriesMock);

vi.mock('@database/queries/touchaiMeta', () => ({
    setMeta: vi.fn(),
}));

vi.mock('@database/schema', () => ({
    MetaKey: {
        IMPORT_SUCCESS: 'IMPORT_SUCCESS',
    },
    StatisticKey: {
        MODEL_METADATA_LAST_UPDATED_AT: 'MODEL_METADATA_LAST_UPDATED_AT',
    },
}));

vi.mock('@tauri-apps/plugin-process', () => ({
    relaunch: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/modelMetadata', () => ({
    updateModelMetadata: vi.fn(),
}));

describe('SettingsDataManagementSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        queriesMock.countSessions.mockResolvedValue(0);
        queriesMock.countMessages.mockResolvedValue(0);
        queriesMock.countSessionTurns.mockResolvedValue(0);
        queriesMock.getStatistic.mockResolvedValue(null);
    });

    it('uses a compact content title and removes decorative data icon copy from the stats card', async () => {
        const wrapper = mount(DataManagementSection, {
            global: {
                stubs: {
                    ImportModeDialog: true,
                    ProgressDialog: true,
                },
            },
        });

        await flushPromises();

        expect(wrapper.get('h1').text()).toBe('数据管理');
        expect(wrapper.text()).not.toContain(
            '查看本地会话规模，维护模型元数据，并进行数据库导入导出。'
        );
        expect(wrapper.text()).not.toContain('当前本地数据库中的主要内容规模。');
        expect(wrapper.find('[data-testid="settings-data-stats-icon"]').exists()).toBe(false);
    });
});
