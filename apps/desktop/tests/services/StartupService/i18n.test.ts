import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MetaKey } from '@/database/schema';
import { setLocale } from '@/i18n';
import { log } from '@/services/ObservabilityService';

const { deleteMetaMock, getMetaMock, notifyMock } = vi.hoisted(() => ({
    deleteMetaMock: vi.fn(),
    getMetaMock: vi.fn(),
    notifyMock: vi.fn(),
}));

vi.mock('@database/queries/touchaiMeta', () => ({
    deleteMeta: deleteMetaMock,
    getMeta: getMetaMock,
}));

vi.mock('@services/NotificationService', () => ({
    notify: notifyMock,
}));

describe('user is told the import succeeded when the app starts again', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        deleteMetaMock.mockResolvedValue(undefined);
        getMetaMock.mockResolvedValue(null);
    });

    it('user reads the import success notice in their own language', async () => {
        setLocale('en-US');
        getMetaMock.mockResolvedValue(
            JSON.stringify({
                type: 'import-success',
                version: 1,
                importMode: 'full',
            })
        );
        const { runStartupTasks } = await import('@services/StartupService');

        await runStartupTasks();

        expect(getMetaMock).toHaveBeenCalledWith({ key: MetaKey.IMPORT_SUCCESS });
        expect(deleteMetaMock).toHaveBeenCalledWith({ key: MetaKey.IMPORT_SUCCESS });
        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Data imported successfully (Overwrite settings and import conversation data incrementally)',
        });
    });

    it('user reads the chat-only import success notice in the active language', async () => {
        setLocale('en-US');
        getMetaMock.mockResolvedValue(
            JSON.stringify({
                type: 'import-success',
                version: 1,
                importMode: 'chat_only',
            })
        );
        const { runStartupTasks } = await import('@services/StartupService');

        await runStartupTasks();

        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'Data imported successfully (Import conversation data only)',
        });
    });

    it('user sees the import success marker saved with its mode', async () => {
        const { serializeImportSuccessStartupPayload } = await import('@services/StartupService');

        expect(JSON.parse(serializeImportSuccessStartupPayload('chat_only'))).toEqual({
            type: 'import-success',
            version: 1,
            importMode: 'chat_only',
        });
    });

    it('user sees an unreadable import marker shown as written', async () => {
        setLocale('en-US');
        const payload = JSON.stringify({
            type: 'import-success',
            version: 99,
            importMode: 'full',
        });
        getMetaMock.mockResolvedValue(payload);
        const { runStartupTasks } = await import('@services/StartupService');

        await runStartupTasks();

        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: payload,
        });
    });

    it('user sees an unsupported import mode shown as written', async () => {
        setLocale('en-US');
        const payload = JSON.stringify({
            type: 'import-success',
            version: 1,
            importMode: 'settings_only',
        });
        getMetaMock.mockResolvedValue(payload);
        const { runStartupTasks } = await import('@services/StartupService');

        await runStartupTasks();

        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: payload,
        });
    });

    it('user can still start the app when a startup task fails', async () => {
        getMetaMock.mockRejectedValueOnce(new Error('metadata unavailable'));
        const consoleSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
        const { runStartupTasks } = await import('@services/StartupService');

        await expect(runStartupTasks()).resolves.toBeUndefined();

        expect(consoleSpy).toHaveBeenCalledWith(
            `Startup task [${MetaKey.IMPORT_SUCCESS}] failed:`,
            expect.any(Error)
        );
        consoleSpy.mockRestore();
    });

    it('user sees an old import notice shown as written', async () => {
        setLocale('en-US');
        getMetaMock.mockResolvedValue('数据导入成功（覆盖设置，差量导入对话数据）');
        const { runStartupTasks } = await import('@services/StartupService');

        await runStartupTasks();

        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: '数据导入成功（覆盖设置，差量导入对话数据）',
        });
    });
});
