import type {
    AnalyticsOperationHandle,
    AnalyticsTrackRequest,
} from '@/services/AnalyticsService/types';

import { mockTauriCommand } from './tauri';

/** Native consent/operation boundary; callers keep the real analytics helpers. */
export function installProductAnalytics() {
    let enabled = true;
    let consentEpoch = 1;
    let sequence = 0;
    const active = new Map<string, AnalyticsOperationHandle>();
    const events: AnalyticsTrackRequest[] = [];
    const released: string[] = [];

    mockTauriCommand('analytics_begin_operation', () => {
        const operation = { operationId: `operation-${++sequence}`, enabled, consentEpoch };
        active.set(operation.operationId, operation);
        return operation;
    });
    mockTauriCommand('analytics_track', (payload: unknown) => {
        const { request } = payload as { request: AnalyticsTrackRequest };
        const operation = request.operationId ? active.get(request.operationId) : undefined;
        if (
            !enabled ||
            (request.operationId &&
                (!operation || !operation.enabled || operation.consentEpoch !== consentEpoch))
        ) {
            return { status: 'disabled' };
        }
        events.push(request);
        return { status: 'persisted', eventId: `event-${events.length}` };
    });
    mockTauriCommand('analytics_complete_operation', (payload: unknown) => {
        const { operationId } = payload as { operationId: string };
        released.push(operationId);
        active.delete(operationId);
    });

    return {
        events,
        active,
        released,
        setEnabled(value: boolean) {
            enabled = value;
            consentEpoch += 1;
        },
    };
}

export function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}
