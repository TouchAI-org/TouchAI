// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { validateAnalyticsAttributes } from './events';
import type {
    AnalyticsAttributes,
    AnalyticsEventName,
    AnalyticsOperationHandle,
    AnalyticsState,
    AnalyticsSubmitResult,
    AnalyticsTrackRequest,
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
export interface AnalyticsNativePort {
    getState(): Promise<AnalyticsState>;
    setEnabled(enabled: boolean, expectedConsentEpoch: number): Promise<AnalyticsState>;
    clearPending(expectedConsentEpoch: number): Promise<AnalyticsState>;
    flush(): Promise<void>;
    beginOperation(startedAtMs: number): Promise<AnalyticsOperationHandle>;
    completeOperation(operationId: string): Promise<void>;
    track(request: AnalyticsTrackRequest): Promise<AnalyticsSubmitResult>;
}

class AnalyticsService {
    private disposed = false;
    constructor(private readonly io: AnalyticsNativePort) {}
    dispose(): void {
        this.disposed = true;
    }
    async getState(): Promise<AnalyticsState> {
        return this.io.getState();
    }

    async setEnabled(enabled: boolean, expectedConsentEpoch: number): Promise<AnalyticsState> {
        return this.io.setEnabled(enabled, expectedConsentEpoch);
    }

    async clearPending(expectedConsentEpoch: number): Promise<AnalyticsState> {
        return this.io.clearPending(expectedConsentEpoch);
    }

    async flush(): Promise<void> {
        await this.io.flush();
    }

    /**
     * Asks the native runtime for an operation handle before a potentially long
     * operation starts. The native side owns the session and the consent epoch
     * bound to the handle, so a completion cannot borrow a newer epoch and the
     * WebView never supplies a session id.
     */
    async beginOperation(): Promise<AnalyticsOperationHandle> {
        // Capture the action-start instant synchronously, before an IPC queue
        // delay can let the user change consent. Native refuses to bind an
        // operation whose start predates the latest consent transition.
        if (this.disposed) return { operationId: '', enabled: false, consentEpoch: 0 };
        const startedAtMs = Date.now();
        try {
            const operation = await this.io.beginOperation(startedAtMs);
            if (operation?.operationId) {
                if (this.disposed) {
                    await this.completeOperation(operation);
                    return { operationId: '', enabled: false, consentEpoch: 0 };
                }
                return operation;
            }
        } catch {
            // Fall through to the unavailable handle.
        }
        return { operationId: '', enabled: false, consentEpoch: 0 };
    }

    /** Releases a native operation handle once the operation is finished. */
    async completeOperation(operation: AnalyticsOperationHandle): Promise<void> {
        if (!operation.operationId) {
            return;
        }
        try {
            await this.io.completeOperation(operation.operationId);
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

        if (this.disposed || (options.operation && !options.operation.enabled)) {
            return { status: 'disabled' };
        }

        try {
            const request: AnalyticsTrackRequest = {
                eventName,
                occurredAtMs: options.occurredAtMs ?? Date.now(),
                operationId: options.operation?.operationId,
                attributes: validated,
            };
            return await this.io.track(request);
        } catch {
            return { status: 'error' };
        }
    }
}

export function createAnalytics(io: AnalyticsNativePort) {
    return new AnalyticsService(io);
}
export type AnalyticsSink = Pick<
    AnalyticsService,
    'beginOperation' | 'completeOperation' | 'track'
>;
