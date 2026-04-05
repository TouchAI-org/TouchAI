// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { sendNotification } from '@tauri-apps/plugin-notification';

import type { RuntimePersistenceIssue } from '../execution';

/**
 * `outputs` 层负责把运行事实输出到外部世界。
 *
 * 例如写数据库、发通知、上报持久化异常。
 * 它消费运行结果，但不反向控制主执行流程。
 */
export async function reportRuntimePersistenceIssue(issue: RuntimePersistenceIssue): Promise<void> {
    try {
        await sendNotification({
            title: issue.title,
            body: issue.body,
        });
    } catch (error) {
        console.error('[RuntimeNotificationOutput] Failed to send notification:', error, issue);
    }
}

export { PersistenceProjector } from './persistence';
