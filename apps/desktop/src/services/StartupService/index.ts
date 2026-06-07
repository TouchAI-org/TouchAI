// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { deleteMeta, getMeta } from '@database/queries/touchaiMeta';
import { MetaKey } from '@database/schema';
import { notify } from '@services/NotificationService';

import { t } from '@/i18n';
import type { ImportMode } from '@/services/DataManagementService';

interface ImportSuccessStartupPayload {
    type: 'import-success';
    version: 1;
    importMode: ImportMode;
}

interface StartupTask {
    key: MetaKey;
    handler?: (value: string) => void | Promise<void>;
}

export function serializeImportSuccessStartupPayload(importMode: ImportMode): string {
    const payload: ImportSuccessStartupPayload = {
        type: 'import-success',
        version: 1,
        importMode,
    };

    return JSON.stringify(payload);
}

function parseImportSuccessStartupPayload(value: string): ImportSuccessStartupPayload | null {
    try {
        const payload = JSON.parse(value) as Partial<ImportSuccessStartupPayload>;
        if (payload.type !== 'import-success' || payload.version !== 1) {
            return null;
        }

        if (payload.importMode !== 'chat_only' && payload.importMode !== 'full') {
            return null;
        }

        return {
            type: 'import-success',
            version: 1,
            importMode: payload.importMode,
        };
    } catch {
        return null;
    }
}

function getImportModeNotificationText(importMode: ImportMode): string {
    return importMode === 'chat_only'
        ? t('startup.import.mode.chatOnly')
        : t('startup.import.mode.full');
}

function notifyImportSuccess(value: string): void {
    const payload = parseImportSuccessStartupPayload(value);
    if (!payload) {
        notify({ title: 'TouchAI', body: value });
        return;
    }

    notify({
        title: 'TouchAI',
        body: t('startup.import.successBody', {
            mode: getImportModeNotificationText(payload.importMode),
        }),
    });
}

/**
 * 启动任务注册表
 * 每个任务绑定一个 MetaKey，应用启动时检查该 key 是否有值，
 * 有值则执行回调并自动清除标记，适用于跨重启的一次性任务。
 */
const tasks: StartupTask[] = [
    {
        key: MetaKey.IMPORT_SUCCESS,
        handler: notifyImportSuccess,
    },
];

export async function runStartupTasks() {
    for (const task of tasks) {
        try {
            const value = await getMeta({ key: task.key });
            if (value) {
                await deleteMeta({ key: task.key });
                await task.handler?.(value);
            }
        } catch (error) {
            console.error(`Startup task [${task.key}] failed:`, error);
        }
    }
}
