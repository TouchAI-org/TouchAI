import { afterEach, describe, expect, it } from 'vitest';
import { computed } from 'vue';

import { getLocale, setLocale } from '@/i18n';
import { createUpdateNotificationBody } from '@/services/AppUpdateService/notificationText';
import { appUpdateReleaseNotes } from '@/services/AppUpdateService/releaseNotes';
import { createInitialAppUpdateState } from '@/services/AppUpdateService/state';

function state() {
    return {
        ...createInitialAppUpdateState(),
        availableUpdate: {
            version: '1.2.3',
            fileName: 'TouchAI-1.2.3.nupkg',
            notes: 'Legacy package notes',
            sizeBytes: null,
        },
        latestUpdate: {
            version: '1.2.3',
            tag: 'v1.2.3',
            releaseUrl: 'https://example.com/releases/v1.2.3',
            publishedAt: null,
            prerelease: false,
            releaseNotes: 'Legacy feed notes',
            releaseNotesByLocale: { 'en-US': 'Safer updates', 'zh-CN': '更安全的更新' },
            downloads: [],
        },
    };
}

afterEach(() => setLocale('zh-CN'));

describe('given the same update is visible while the app language changes', () => {
    it('user reads matching notes and notifications immediately without another update check', () => {
        const update = state();
        const visibleNotes = computed(() => appUpdateReleaseNotes(update, getLocale()));
        setLocale('zh-CN');
        expect(visibleNotes.value).toBe('更安全的更新');
        expect(createUpdateNotificationBody(update)).toBe('更安全的更新');
        setLocale('en-US');
        expect(visibleNotes.value).toBe('Safer updates');
        expect(createUpdateNotificationBody(update)).toBe('Safer updates');
    });

    it('user reads English and then legacy content when translations are missing or blank', () => {
        const update = state();
        update.latestUpdate.releaseNotesByLocale['zh-CN'] = ' ';
        expect(appUpdateReleaseNotes(update, 'zh-CN')).toBe('Safer updates');
        update.latestUpdate.releaseNotesByLocale['en-US'] = '';
        expect(appUpdateReleaseNotes(update, 'zh-CN')).toBe('Legacy package notes');
        update.availableUpdate.notes = '';
        expect(appUpdateReleaseNotes(update, 'en-US')).toBe('Legacy feed notes');
        expect(appUpdateReleaseNotes(createInitialAppUpdateState(), 'en-US')).toBe('');
    });

    it('user never reads another version’s notes when a previously downloaded update is shown', () => {
        const update = {
            ...state(),
            downloadedUpdate: { ...state().availableUpdate, version: '1.2.2' },
        };
        expect(appUpdateReleaseNotes(update, 'zh-CN')).toBe('Legacy package notes');
        update.downloadedUpdate.notes = '';
        expect(appUpdateReleaseNotes(update, 'zh-CN')).toBe('');
    });

    it('user reads compatible English keys supplied by older publishers', () => {
        const update = {
            ...state(),
            latestUpdate: {
                ...state().latestUpdate,
                releaseNotesByLocale: { en: 'English notes' },
            },
        };
        expect(appUpdateReleaseNotes(update, 'en-US')).toBe('English notes');
    });
});
