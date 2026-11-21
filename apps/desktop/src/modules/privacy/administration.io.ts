import { findSessionTitlesByIds } from '@/database/queries/sessions';
import { native } from '@/platform/native';
import { createWindowEvent } from '@/platform/windows/events';

import {
    PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT,
    PRIVACY_FILTER_RECORDS_CHANGED_EVENT,
    type PrivacyFilterDownloadProgress,
} from './contracts';

export function createPrivacyAdministration() {
    const records = createWindowEvent<{ cleared?: boolean; generation?: number } | null>(
        PRIVACY_FILTER_RECORDS_CHANGED_EVENT
    );
    const downloads = createWindowEvent<PrivacyFilterDownloadProgress>(
        PRIVACY_FILTER_DOWNLOAD_PROGRESS_EVENT
    );
    return Object.freeze({
        getRecords: native.privacyFilter.getRecords,
        getDetailRecordIds: native.privacyFilter.getDetailRecordIds,
        getRecordDetails: native.privacyFilter.getRecordDetails,
        clearRecords: native.privacyFilter.clearRecords,
        getModels: native.privacyFilter.getModels,
        getModelStatus: native.privacyFilter.getModelStatus,
        downloadModel: native.privacyFilter.downloadModel,
        cancelModelDownload: native.privacyFilter.cancelModelDownload,
        deleteModel: native.privacyFilter.deleteModel,
        releaseModels: native.privacyFilter.releaseModels,
        detect: native.privacyFilter.detect,
        findSessionTitles: findSessionTitlesByIds,
        onRecordsChanged: (
            listener: (event: { cleared?: boolean; generation?: number } | null) => void
        ) => records.on(listener),
        onDownloadProgress: (listener: (progress: PrivacyFilterDownloadProgress) => void) =>
            downloads.on(listener),
    });
}
