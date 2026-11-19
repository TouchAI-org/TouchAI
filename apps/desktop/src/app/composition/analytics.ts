import {
    createAnalytics,
    createAnalyticsAdmission,
    createProductAnalytics,
    createUpdateAnalytics,
} from '@/modules/analytics';
import type { AnalyticsPreferences, ProductAnalytics } from '@/modules/analytics/public';
import { log } from '@/platform/diagnostics';
import { native } from '@/platform/native';

/** Native remains the process authority; this observer owns only its window lifetime. */
export function assembleAnalyticsWindow(label: string | null) {
    const owner = createAnalytics(native.analytics);
    const admission = createAnalyticsAdmission(owner);
    const interactions = createProductAnalytics(admission);
    const product: ProductAnalytics = Object.freeze({
        trackSurfaceOpened: interactions.trackSurfaceOpened,
        beginProviderConfigurationAttempt: interactions.beginProviderConfigurationAttempt,
        runProviderConfigurationAttempt: interactions.runProviderConfigurationAttempt,
        runProviderConfiguration: interactions.runProviderConfiguration,
        beginSearchInteraction: interactions.beginSearchInteraction,
        settleSearchInteraction: interactions.settleSearchInteraction,
        trackSearchFeatureExposed: interactions.trackSearchFeatureExposed,
        selectSearchResult: interactions.selectSearchResult,
        finishSearchInteraction: interactions.finishSearchInteraction,
        runResultAction: interactions.runResultAction,
    });
    const choice = (state: Awaited<ReturnType<typeof owner.getState>>) => {
        log.debug('[Analytics] State', {
            status: state.status,
            transportReady: state.transportReady,
            queueDepth: state.queueDepth,
            pendingBytes: state.pendingBytes,
        });
        return {
            status: state.status,
            consentEpoch: state.consentEpoch,
            canEnable: state.buildEligible && state.transportReady,
        };
    };
    const preferences: AnalyticsPreferences | undefined =
        label === 'settings'
            ? Object.freeze({
                  async getChoice() {
                      return choice(await owner.getState());
                  },
                  async setEnabled(enabled: boolean, expectedConsentEpoch: number) {
                      return choice(await owner.setEnabled(enabled, expectedConsentEpoch));
                  },
              })
            : undefined;
    return Object.freeze({
        product,
        preferences,
        sink: Object.freeze({
            beginOperation: owner.beginOperation.bind(owner),
            completeOperation: owner.completeOperation.bind(owner),
            track: owner.track.bind(owner),
        }),
        updates: createUpdateAnalytics(admission),
        dispose() {
            admission.dispose();
            owner.dispose();
        },
    });
}
