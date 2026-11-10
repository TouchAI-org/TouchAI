import type { AppUpdateState } from './types';

export function appUpdateReleaseNotes(state: AppUpdateState, locale: string): string {
    const update = state.downloadedUpdate ?? state.availableUpdate;
    const latest = state.latestUpdate;
    if (update && latest?.version !== update.version) {
        return update.notes?.trim() || '';
    }

    const localized = latest?.releaseNotesByLocale;
    return (
        localized?.[locale]?.trim() ||
        localized?.[locale.split('-')[0] ?? locale]?.trim() ||
        localized?.['en-US']?.trim() ||
        localized?.en?.trim() ||
        update?.notes?.trim() ||
        latest?.releaseNotes?.trim() ||
        ''
    );
}
