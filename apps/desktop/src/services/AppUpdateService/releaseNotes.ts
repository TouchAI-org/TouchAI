import compare from 'semver/functions/compare';
import valid from 'semver/functions/valid';

import type { AppUpdateChannelLatest, AppUpdateChannelReleaseNote, AppUpdateState } from './types';

export interface AppUpdateReleaseSection {
    version: string;
    publishedAt: string | null;
    notes: string;
}

function localizedReleaseNotes(
    release: AppUpdateChannelLatest | AppUpdateChannelReleaseNote,
    locale: string
): string {
    const localized = release.releaseNotesByLocale;
    return (
        localized?.[locale]?.trim() ||
        localized?.[locale.split('-')[0] ?? locale]?.trim() ||
        localized?.['en-US']?.trim() ||
        localized?.en?.trim() ||
        ''
    );
}

function releaseNotesForEntry(
    release: AppUpdateChannelLatest | AppUpdateChannelReleaseNote,
    locale: string
): string {
    return localizedReleaseNotes(release, locale) || release.releaseNotes?.trim() || '';
}

export function appUpdateReleaseNotes(state: AppUpdateState, locale: string): string {
    const update = state.downloadedUpdate ?? state.availableUpdate;
    const latest = state.latestUpdate;
    if (update && latest?.version !== update.version) {
        return update.notes?.trim() || '';
    }

    if (latest) {
        const localized = localizedReleaseNotes(latest, locale);
        if (localized) {
            return localized;
        }
        if (update?.notes?.trim()) {
            return update.notes.trim();
        }
        if (latest.releaseNotes?.trim()) {
            return latest.releaseNotes.trim();
        }
    }

    return update?.notes?.trim() || '';
}

/**
 * Release notes for every version crossed on the way to the visible update,
 * newest first. A single entry stays primary when the install is current.
 */
export function appUpdateReleaseSections(
    state: AppUpdateState,
    locale: string,
    currentVersion: string
): AppUpdateReleaseSection[] {
    const update = state.downloadedUpdate ?? state.availableUpdate;
    const latest = state.latestUpdate;
    const targetVersion = update?.version ?? latest?.version;
    if (!targetVersion || !valid(targetVersion)) {
        return [];
    }

    if (!update) {
        const notes = appUpdateReleaseNotes(state, locale);
        return notes
            ? [
                  {
                      version: targetVersion,
                      publishedAt: latest?.publishedAt ?? null,
                      notes,
                  },
              ]
            : [];
    }

    if (!latest || latest.version !== targetVersion) {
        const notes = update.notes?.trim() || '';
        return notes ? [{ version: targetVersion, publishedAt: null, notes }] : [];
    }

    const current = valid(currentVersion);
    const byVersion = new Map<string, AppUpdateReleaseSection>();
    for (const release of [latest, ...(latest.releaseHistory ?? [])]) {
        if (!valid(release.version)) {
            continue;
        }

        const isTarget = release.version === targetVersion;
        const crossed =
            current !== null &&
            compare(release.version, current) > 0 &&
            compare(release.version, targetVersion) < 0;
        if (!isTarget && !crossed) {
            continue;
        }

        const notes = isTarget
            ? appUpdateReleaseNotes(state, locale)
            : releaseNotesForEntry(release, locale);
        if (!notes || byVersion.has(release.version)) {
            continue;
        }

        byVersion.set(release.version, {
            version: release.version,
            publishedAt: release.publishedAt ?? null,
            notes,
        });
    }

    return [...byVersion.values()].sort((left, right) => compare(right.version, left.version));
}
