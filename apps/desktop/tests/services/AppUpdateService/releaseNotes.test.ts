import { afterEach, describe, expect, it } from 'vitest';
import { computed } from 'vue';

import { getLocale, setLocale } from '@/i18n';
import { createUpdateNotificationBody } from '@/services/AppUpdateService/notificationText';
import {
    appUpdateReleaseNotes,
    appUpdateReleaseSections,
} from '@/services/AppUpdateService/releaseNotes';
import { createInitialAppUpdateState } from '@/services/AppUpdateService/state';
import type { AppUpdateChannelLatest } from '@/services/AppUpdateService/types';

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

    it('user sees every skipped release newest first and not the installed release', () => {
        const update = {
            ...state(),
            currentVersion: '1.2.1',
            availableUpdate: { ...state().availableUpdate, version: '1.2.4' },
            latestUpdate: {
                ...state().latestUpdate,
                version: '1.2.4',
                releaseNotesByLocale: {
                    'en-US': 'Target release',
                    'zh-CN': '目标版本',
                },
                releaseHistory: [
                    {
                        version: '1.2.3',
                        publishedAt: '2026-05-23T00:00:00.000Z',
                        releaseNotes: 'Third release',
                        releaseNotesByLocale: { 'en-US': 'Third release' },
                    },
                    {
                        version: '1.2.2',
                        publishedAt: '2026-05-22T00:00:00.000Z',
                        releaseNotes: 'Second release',
                        releaseNotesByLocale: { 'en-US': 'Second release' },
                    },
                    {
                        version: '1.2.1',
                        publishedAt: '2026-05-21T00:00:00.000Z',
                        releaseNotes: 'Installed release',
                        releaseNotesByLocale: { 'en-US': 'Installed release' },
                    },
                ],
            } satisfies AppUpdateChannelLatest,
        };

        expect(
            appUpdateReleaseSections(update, 'en-US', '1.2.1').map((section) => section.version)
        ).toEqual(['1.2.4', '1.2.3', '1.2.2']);
    });

    it('user sees only the visible version notes when no feed history is available', () => {
        const update = state();
        update.currentVersion = '1.2.0';
        update.latestUpdate = {
            ...update.latestUpdate,
            releaseNotesByLocale: {
                'en-US': 'Target release',
                'zh-CN': '目标版本',
            },
        };

        expect(appUpdateReleaseSections(update, 'en-US', '1.2.0')).toEqual([
            {
                version: '1.2.3',
                publishedAt: null,
                notes: 'Target release',
            },
        ]);
    });

    it('user sees only the installed release notes when already current', () => {
        const update = {
            ...state(),
            currentVersion: '1.2.3',
            availableUpdate: null,
            latestUpdate: {
                ...state().latestUpdate,
                releaseHistory: [
                    {
                        version: '1.2.2',
                        publishedAt: '2026-05-22T00:00:00.000Z',
                        releaseNotes: 'Older release',
                        releaseNotesByLocale: { 'en-US': 'Older release' },
                    },
                ],
            },
        };

        expect(appUpdateReleaseSections(update, 'en-US', '1.2.3')).toEqual([
            {
                version: '1.2.3',
                publishedAt: null,
                notes: 'Safer updates',
            },
        ]);
    });
});
