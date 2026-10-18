import {
    createUpdateNotificationBody,
    summarizeUpdateReleaseNotes,
} from '@services/AppUpdateService/notificationText';
import { createInitialAppUpdateState } from '@services/AppUpdateService/state';
import type { AppUpdateState } from '@services/AppUpdateService/types';
import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

function createState(patch: Partial<AppUpdateState> = {}): AppUpdateState {
    return {
        ...createInitialAppUpdateState(),
        status: 'available',
        availableUpdate: {
            version: '1.2.3',
            fileName: 'TouchAI-1.2.3.nupkg',
            notes: null,
            sizeBytes: null,
        },
        ...patch,
    };
}

describe('update notification text', () => {
    it('turns markdown release notes into a concise notification summary', () => {
        expect(
            summarizeUpdateReleaseNotes(
                '## 更新内容\n\n- 修复 [设置窗口](https://example.com) 问题\n- `Ctrl+K` 可用'
            )
        ).toBe('更新内容 · 修复 设置窗口 问题 · Ctrl+K 可用');
    });

    it('uses package notes before release notes', () => {
        setLocale('zh-CN');
        const state = createState({
            availableUpdate: {
                version: '1.2.3',
                fileName: 'TouchAI-1.2.3.nupkg',
                notes: '- 修复安装问题',
                sizeBytes: null,
            },
            latestUpdate: {
                version: '1.2.3',
                tag: 'v1.2.3',
                releaseUrl: 'https://example.com/releases/v1.2.3',
                publishedAt: null,
                prerelease: false,
                releaseNotes: '- 不应优先使用',
                downloads: [],
            },
        });

        expect(createUpdateNotificationBody(state)).toBe('修复安装问题');
    });

    it('falls back to release notes and keeps the no-notes message useful', () => {
        setLocale('en-US');
        const state = createState({
            availableUpdate: null,
            latestUpdate: {
                version: '1.2.3',
                tag: 'v1.2.3',
                releaseUrl: 'https://example.com/releases/v1.2.3',
                publishedAt: null,
                prerelease: false,
                releaseNotes: 'Improves startup speed',
                downloads: [],
            },
        });

        expect(createUpdateNotificationBody(state)).toBe('Improves startup speed');
        expect(
            createUpdateNotificationBody(createState({ availableUpdate: null, latestUpdate: null }))
        ).toBe('Release notes are not available.');
    });
});
