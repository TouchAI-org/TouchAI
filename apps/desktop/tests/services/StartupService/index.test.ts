import { deleteMeta, getMeta } from '@database/queries/touchaiMeta';
import { MetaKey } from '@database/schema';
import { notify } from '@services/NotificationService';
import { runStartupTasks } from '@services/StartupService';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@database/queries/touchaiMeta', () => ({
    getMeta: vi.fn(),
    deleteMeta: vi.fn(),
}));

vi.mock('@services/NotificationService', () => ({
    notify: vi.fn(),
}));

describe('StartupService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('clears stale import success metadata and shows the legacy success notification', async () => {
        vi.mocked(getMeta).mockResolvedValue('数据导入成功');

        await runStartupTasks();

        expect(getMeta).toHaveBeenCalledWith({ key: MetaKey.IMPORT_SUCCESS });
        expect(deleteMeta).toHaveBeenCalledWith({ key: MetaKey.IMPORT_SUCCESS });
        expect(notify).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: '数据导入成功',
        });
    });
});
