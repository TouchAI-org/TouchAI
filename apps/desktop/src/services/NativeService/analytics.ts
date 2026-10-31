// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type {
    AnalyticsLifecycleContext,
    AnalyticsOperationHandle,
    AnalyticsState,
    AnalyticsSubmitResult,
    AnalyticsTrackRequest,
} from '@services/AnalyticsService/types';

import { invoke } from './invoke';

export const analytics = {
    getState(): Promise<AnalyticsState> {
        return invoke<AnalyticsState>('analytics_get_state');
    },

    setEnabled(enabled: boolean, expectedConsentEpoch: number): Promise<AnalyticsState> {
        return invoke<AnalyticsState>('analytics_set_enabled', {
            enabled,
            expectedConsentEpoch,
        });
    },

    clearPending(expectedConsentEpoch: number): Promise<AnalyticsState> {
        return invoke<AnalyticsState>('analytics_clear_pending', {
            expectedConsentEpoch,
        });
    },

    track(request: AnalyticsTrackRequest): Promise<AnalyticsSubmitResult> {
        return invoke<AnalyticsSubmitResult>('analytics_track', { request });
    },

    flush(): Promise<void> {
        return invoke<void>('analytics_flush');
    },

    getLifecycleContext(): Promise<AnalyticsLifecycleContext> {
        return invoke<AnalyticsLifecycleContext>('analytics_get_lifecycle_context');
    },

    beginOperation(): Promise<AnalyticsOperationHandle> {
        return invoke<AnalyticsOperationHandle>('analytics_begin_operation');
    },

    completeOperation(operationId: string): Promise<void> {
        return invoke<void>('analytics_complete_operation', { operationId });
    },
} as const;
