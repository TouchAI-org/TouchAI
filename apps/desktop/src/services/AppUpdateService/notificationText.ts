import { t } from '@/i18n';
import { collapseWhitespace, truncateText } from '@/utils/text';

import type { AppUpdateState } from './types';

const MAX_NOTIFICATION_NOTES_LENGTH = 240;

/**
 * Keep release notes readable in native notifications without exposing the
 * markdown syntax used by the update details view.
 */
export function summarizeUpdateReleaseNotes(notes: string | null | undefined): string | null {
    if (!notes?.trim()) return null;

    const summary = collapseWhitespace(
        notes
            .replace(/```[\w-]*\s*/g, '')
            .replace(/`([^`]+)`/g, '$1')
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/<[^>]+>/g, ' ')
            .replace(/^\s{0,3}#{1,6}\s+/gm, '')
            .replace(/^\s*>\s?/gm, '')
            .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, '')
            .replace(/[*_~]/g, '')
            .replace(/\r?\n+/g, ' · ')
    );

    return summary ? truncateText(summary, MAX_NOTIFICATION_NOTES_LENGTH) : null;
}

export function createUpdateNotificationBody(state: AppUpdateState): string {
    const packageNotes =
        state.downloadedUpdate?.notes?.trim() || state.availableUpdate?.notes?.trim();
    const notes = summarizeUpdateReleaseNotes(packageNotes || state.latestUpdate?.releaseNotes);

    return notes || t('notification.update.bodyWithoutNotes');
}
