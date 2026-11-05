// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import { validateAnalyticsAttributes } from './events';
import type {
    AnalyticsAttributes,
    AnalyticsEventName,
    AnalyticsOperationHandle,
    AnalyticsState,
    AnalyticsSubmitResult,
    AnalyticsTrackRequest,
} from './types';

export {
    ANALYTICS_EVENT_SCHEMAS,
    isAnalyticsEventName,
    validateAnalyticsAttributes,
} from './events';
export {
    ANALYTICS_EVENT_NAMES,
    type AnalyticsAttributes,
    type AnalyticsAttributeValue,
    type AnalyticsConsentStatus,
    type AnalyticsEventName,
    type AnalyticsOperationHandle,
    type AnalyticsState,
    type AnalyticsSubmitResult,
    type AnalyticsSubmitStatus,
    type AnalyticsTrackRequest,
} from './types';

export interface AnalyticsTrackOptions {
    occurredAtMs?: number;
    operation?: AnalyticsOperationHandle;
}

/**
 * Public analytics boundary.
 *
 * Business call sites submit typed metadata only. The service never throws into
 * a caller: invalid input and an unavailable native channel become a result the
 * caller can ignore. Identity, version and platform are filled by Rust.
 */
class AnalyticsService {
    async getState(): Promise<AnalyticsState> {
        return native.analytics.getState();
    }

    async setEnabled(enabled: boolean, expectedConsentEpoch: number): Promise<AnalyticsState> {
        return native.analytics.setEnabled(enabled, expectedConsentEpoch);
    }

    async clearPending(expectedConsentEpoch: number): Promise<AnalyticsState> {
        return native.analytics.clearPending(expectedConsentEpoch);
    }

    async flush(): Promise<void> {
        await native.analytics.flush();
    }

    /**
     * Asks the native runtime for an operation handle before a potentially long
     * operation starts. The native side owns the session and the consent epoch
     * bound to the handle, so a completion cannot borrow a newer epoch and the
     * WebView never supplies a session id.
     */
    async beginOperation(): Promise<AnalyticsOperationHandle> {
        try {
            return await native.analytics.beginOperation();
        } catch {
            return { operationId: '', enabled: false, consentEpoch: 0 };
        }
    }

    /** Releases a native operation handle once the operation is finished. */
    async completeOperation(operation: AnalyticsOperationHandle): Promise<void> {
        if (!operation.operationId) {
            return;
        }
        try {
            await native.analytics.completeOperation(operation.operationId);
        } catch {
            // A dropped handle only costs a bounded registry slot; nothing to report.
        }
    }

    async track<T extends AnalyticsEventName>(
        eventName: T,
        attributes: AnalyticsAttributes,
        options: AnalyticsTrackOptions = {}
    ): Promise<AnalyticsSubmitResult> {
        let validated: AnalyticsAttributes;
        try {
            validated = validateAnalyticsAttributes(eventName, attributes);
        } catch {
            return { status: 'rejected', reason: 'invalid_attributes' };
        }

        if (options.operation && !options.operation.enabled) {
            return { status: 'disabled' };
        }

        try {
            const request: AnalyticsTrackRequest = {
                eventName,
                occurredAtMs: options.occurredAtMs ?? Date.now(),
                operationId: options.operation?.operationId,
                attributes: validated,
            };
            return await native.analytics.track(request);
        } catch {
            return { status: 'error' };
        }
    }
}

export const analytics = new AnalyticsService();
