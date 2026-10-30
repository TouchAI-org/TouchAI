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
    ANALYTICS_SEND_PATH,
    analyticsSendUrl,
    type AnalyticsWireInput,
    buildAnalyticsWireEvent,
    isSupportedAnalyticsProtocolVersion,
} from './transport';
export {
    ANALYTICS_EVENT_NAMES,
    ANALYTICS_PROTOCOL_VERSION,
    ANALYTICS_SCHEMA_VERSION,
    ANALYTICS_WIRE_HOSTNAME,
    ANALYTICS_WIRE_URL,
    type AnalyticsAttributes,
    type AnalyticsAttributeValue,
    type AnalyticsConsentStatus,
    type AnalyticsEventName,
    type AnalyticsOperationHandle,
    type AnalyticsState,
    type AnalyticsSubmitResult,
    type AnalyticsSubmitStatus,
    type AnalyticsTrackRequest,
    type AnalyticsWireData,
    type AnalyticsWireEvent,
    type AnalyticsWirePayload,
} from './types';

export interface AnalyticsTrackOptions {
    occurredAtMs?: number;
    consentEpoch?: number;
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
     * Captures the current consent epoch and a task-local operation id before a
     * potentially long operation starts. A handle captured while disabled stays
     * disabled, and a later completion cannot borrow a newer epoch.
     */
    async beginOperation(): Promise<AnalyticsOperationHandle> {
        const operationId = createAnalyticsOperationId();
        try {
            const state = await native.analytics.getState();
            return {
                operationId,
                enabled: state.status === 'enabled',
                consentEpoch: state.consentEpoch,
            };
        } catch {
            return { operationId, enabled: false, consentEpoch: 0 };
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

        let consentEpoch = options.operation?.consentEpoch ?? options.consentEpoch;
        try {
            if (consentEpoch === undefined) {
                const state = await native.analytics.getState();
                if (state.status !== 'enabled') {
                    return { status: 'disabled' };
                }
                consentEpoch = state.consentEpoch;
            }

            const request: AnalyticsTrackRequest = {
                eventName,
                occurredAtMs: options.occurredAtMs ?? Date.now(),
                consentEpoch,
                attributes: validated,
            };
            return await native.analytics.track(request);
        } catch {
            return { status: 'error' };
        }
    }
}

export function createAnalyticsOperationId(): string {
    return crypto.randomUUID();
}

export const analytics = new AnalyticsService();
