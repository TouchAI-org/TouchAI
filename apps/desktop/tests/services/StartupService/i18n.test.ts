import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { MetaKey } from '@/database/schema';

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

describe('StartupService i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        deleteMetaMock.mockResolvedValue(undefined);
        getMetaMock.mockResolvedValue(null);
    });

    it('localizes persisted import-success notifications after startup settings have loaded', async () => {
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

    it('localizes chat-only import-success notifications from the persisted startup payload', async () => {
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

    it('serializes structured startup import-success payloads', async () => {
        const { serializeImportSuccessStartupPayload } = await import('@services/StartupService');

        expect(JSON.parse(serializeImportSuccessStartupPayload('chat_only'))).toEqual({
            type: 'import-success',
            version: 1,
            importMode: 'chat_only',
        });
    });

    it('falls back to raw notification text for malformed structured payloads', async () => {
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

    it('falls back to raw notification text when import mode is unsupported', async () => {
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

    it('logs startup task failures without throwing', async () => {
        getMetaMock.mockRejectedValueOnce(new Error('metadata unavailable'));
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { runStartupTasks } = await import('@services/StartupService');

        await expect(runStartupTasks()).resolves.toBeUndefined();

        expect(consoleSpy).toHaveBeenCalledWith(
            `Startup task [${MetaKey.IMPORT_SUCCESS}] failed:`,
            expect.any(Error)
        );
        consoleSpy.mockRestore();
    });

    it('keeps legacy raw import-success messages working', async () => {
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
