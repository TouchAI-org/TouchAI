import type { PrivacyApi, PrivacySettingsApi } from '@/app/api/privacy';
import { createPrivacyAdministration, createPrivacyReview } from '@/modules/privacy';
import { log } from '@/platform/diagnostics';

export function assemblePrivacyWindow(settings: PrivacySettingsApi) {
    const administration = createPrivacyAdministration();
    const review = createPrivacyReview();
    let disposed = false;
    let clearedGeneration = -1;
    const clearAtGeneration = (generation: number) => {
        if (disposed || generation <= clearedGeneration) return;
        clearedGeneration = generation;
        review.clearPrivacyReview();
    };
    let unlisten: (() => void) | undefined;
    const ready = administration
        .onRecordsChanged((event) => {
            if (event?.cleared && typeof event.generation === 'number')
                clearAtGeneration(event.generation);
        })
        .then((stop) => {
            if (disposed) stop();
            else unlisten = stop;
        })
        .catch(() => log.warn('[PrivacyProtection] Could not subscribe to cleared review records'));
    const api: PrivacyApi = Object.freeze({
        ...settings,
        ...administration,
        getReviewSnapshot: review.getReviewSnapshot,
        subscribeReview: review.subscribeReview,
        publishPrivacyReview: review.publishPrivacyReview,
        clearPrivacyReview: review.clearPrivacyReview,
        publishRestoredPrivacyReview: review.publishRestoredPrivacyReview,
        selectPrivacyAnnotations: review.selectPrivacyAnnotations,
        selectRestoredPrivacyAnnotations: review.selectRestoredPrivacyAnnotations,
        getReviewGeneration: review.privacyReviewGeneration,
        async clearRecords() {
            const generation = await administration.clearRecords();
            clearAtGeneration(generation);
        },
    });
    return Object.freeze({
        api,
        review,
        ready,
        dispose() {
            if (disposed) return;
            disposed = true;
            unlisten?.();
            review.dispose();
        },
    });
}
