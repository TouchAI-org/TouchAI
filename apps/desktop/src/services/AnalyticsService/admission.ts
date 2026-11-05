// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { analytics } from './index';
import type {
    AnalyticsAttributes,
    AnalyticsEventName,
    AnalyticsOperationHandle,
    AnalyticsSubmitResult,
} from './types';

const ADMISSION_DEADLINE_MS = 50;
const MAX_ACTIVE_OPERATIONS = 16;
const MAX_ACTIVE_SENDS = 64;

const operationBudget = { active: 0 };
const sendBudget = { active: 0 };
let operationGeneration = 0;
let sendGeneration = 0;
let admittedOperations = new WeakMap<
    AnalyticsOperationHandle,
    { operation: AnalyticsOperationHandle; generation: number }
>();

export const UNAVAILABLE_ANALYTICS_OPERATION: AnalyticsOperationHandle = {
    operationId: '',
    enabled: false,
    consentEpoch: 0,
};

function releaseOperation(generation: number): void {
    if (generation === operationGeneration) {
        operationBudget.active = Math.max(0, operationBudget.active - 1);
    }
}

function releaseSend(generation: number): void {
    if (generation === sendGeneration) {
        sendBudget.active = Math.max(0, sendBudget.active - 1);
    }
}

function withDeadline<T>(work: Promise<T>, onSettled: () => void): Promise<T | undefined> {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            settled = true;
            resolve(undefined);
        }, ADMISSION_DEADLINE_MS);
        work.then(
            (value) => {
                clearTimeout(timer);
                onSettled();
                if (!settled) {
                    settled = true;
                    resolve(value);
                }
            },
            () => {
                clearTimeout(timer);
                onSettled();
                if (!settled) {
                    settled = true;
                    resolve(undefined);
                }
            }
        );
    });
}

function releaseLateOperation(operation: AnalyticsOperationHandle, generation: number): void {
    const completion = analytics.completeOperation(operation);
    void completion.then(
        () => releaseOperation(generation),
        () => releaseOperation(generation)
    );
}

/**
 * Admits one native operation without allowing a stalled IPC call to consume
 * the WebView forever. A timed-out begin still owns its slot until the native
 * promise actually settles; a late handle is released without emitting.
 */
export function beginAdmittedOperation(): Promise<AnalyticsOperationHandle | null> {
    if (operationBudget.active >= MAX_ACTIVE_OPERATIONS) {
        return Promise.resolve(null);
    }
    operationBudget.active += 1;
    const generation = operationGeneration;
    let request: Promise<AnalyticsOperationHandle>;
    try {
        request = analytics.beginOperation();
    } catch {
        releaseOperation(generation);
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        let timedOut = false;
        let settled = false;
        const timer = setTimeout(() => {
            timedOut = true;
            resolve(null);
        }, ADMISSION_DEADLINE_MS);
        request.then(
            (operation) => {
                clearTimeout(timer);
                if (timedOut) {
                    if (operation?.operationId) {
                        releaseLateOperation(operation, generation);
                    } else {
                        releaseOperation(generation);
                    }
                    return;
                }
                settled = true;
                if (!operation?.operationId) {
                    releaseOperation(generation);
                    resolve(null);
                    return;
                }
                // Each admission owns a distinct wrapper even when native (or a
                // test double) returns the same object for repeated calls. The
                // operation id is not a unique local admission token.
                const admitted = { ...operation };
                admittedOperations.set(admitted, { operation, generation });
                resolve(admitted);
            },
            () => {
                clearTimeout(timer);
                releaseOperation(generation);
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            }
        );
    });
}

/**
 * Releases one admitted operation. Waiting is bounded for the product path, but
 * the operation slot remains occupied until the underlying IPC settles.
 */
export function completeAdmittedOperation(operation: AnalyticsOperationHandle): Promise<void> {
    const admitted = admittedOperations.get(operation);
    if (!admitted) {
        return Promise.resolve();
    }
    admittedOperations.delete(operation);

    let completion: Promise<void>;
    try {
        completion = analytics.completeOperation(admitted.operation);
    } catch {
        releaseOperation(admitted.generation);
        return Promise.resolve();
    }
    return withDeadline(completion, () => releaseOperation(admitted.generation)).then(
        () => undefined
    );
}

/**
 * Runs one telemetry send inside the shared WebView budget. Product behavior
 * observes at most the short deadline; a stuck IPC keeps its slot until the
 * native call really settles.
 */
export function runAdmittedAnalyticsSend<T>(start: () => Promise<T>): Promise<T | undefined> {
    if (sendBudget.active >= MAX_ACTIVE_SENDS) {
        return Promise.resolve(undefined);
    }
    sendBudget.active += 1;
    const generation = sendGeneration;
    let work: Promise<T>;
    try {
        work = start();
    } catch {
        releaseSend(generation);
        return Promise.resolve(undefined);
    }
    return withDeadline(work, () => releaseSend(generation));
}

export function trackAdmittedAnalytics<T extends AnalyticsEventName>(
    eventName: T,
    attributes: AnalyticsAttributes,
    options: { operation?: AnalyticsOperationHandle; occurredAtMs?: number } = {}
): Promise<AnalyticsSubmitResult | undefined> {
    return runAdmittedAnalyticsSend(() => analytics.track(eventName, attributes, options));
}

/** Test-only reset so a deliberately hung mock cannot poison later cases. */
export function resetAnalyticsAdmissionForTests(): void {
    operationGeneration += 1;
    sendGeneration += 1;
    operationBudget.active = 0;
    sendBudget.active = 0;
    admittedOperations = new WeakMap();
}
