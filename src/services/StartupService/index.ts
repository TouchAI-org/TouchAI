// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { deleteMeta, getMeta } from '@database/queries/touchaiMeta';
import { MetaKey } from '@database/schema';
import { sendNotification } from '@tauri-apps/plugin-notification';

interface StartupTask {
    key: MetaKey;
    handler: (value: string) => void | Promise<void>;
}

/**
 * 启动任务注册表
 * 每个任务绑定一个 MetaKey，应用启动时检查该 key 是否有值，
 * 有值则执行回调并自动清除标记，适用于跨重启的一次性任务。
 */
const tasks: StartupTask[] = [
    {
        key: MetaKey.IMPORT_SUCCESS,
        handler: (message) => sendNotification({ title: 'TouchAI', body: message }),
    },
];

export async function runStartupTasks() {
    for (const task of tasks) {
        try {
            const value = await getMeta({ key: task.key });
            if (value) {
                await deleteMeta({ key: task.key });
                await task.handler(value);
            }
        } catch (error) {
            console.error(`Startup task [${task.key}] failed:`, error);
        }
    }
}
