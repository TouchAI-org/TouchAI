// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    beginAdmittedOperation,
    completeAdmittedOperation,
    trackAdmittedAnalytics,
    UNAVAILABLE_ANALYTICS_OPERATION,
} from './admission';
import { normalizeAnalyticsVersion } from './events';
import type { AnalyticsOperationHandle } from './types';

/**
 * App update lifecycle instrumentation.
 *
 * One random update operation id spans every normal phase of a single update
 * decision, so check/download/handoff transitions correlate without reusing a
 * version string or a database id. `restart_confirmed` is native-owned and is
 * never emitted from the WebView: native stores a bounded pending update on a
 * successful install handoff and confirms it once, only after a later start
 * observes the target version, so a handoff is never reported as a completed
 * update. Download progress chunks are deliberately not emitted.
 */

export type UpdatePhase =
    | 'check_started'
    | 'check_finished'
    | 'download_started'
    | 'download_finished'
    | 'install_handoff';
export type UpdateSource = 'background' | 'user' | 'other';
export type UpdateResult = 'success' | 'failure' | 'unavailable';

export interface UpdateOperation {
    operation: AnalyticsOperationHandle;
    updateOperationId: string;
    /** True once the native handle has been released. */
    closed: boolean;
    /** Serializes the update phases that share this operation id. */
    pending: Promise<void>;
    /** Bounds continuations when an analytics IPC never settles. */
    pendingCount: number;
}

const MAX_PENDING_UPDATE_PHASES = 32;

/** Opens a bounded update operation when a real update decision starts. */
export async function beginUpdateOperation(
    updateOperationId: string = crypto.randomUUID()
): Promise<UpdateOperation> {
    return {
        operation: (await beginAdmittedOperation()) ?? UNAVAILABLE_ANALYTICS_OPERATION,
        updateOperationId,
        closed: false,
        pending: Promise.resolve(),
        pendingCount: 0,
    };
}

/** Sanitizes a version into the bounded version string the schema accepts. */
export function boundedVersion(value: string | null | undefined): string | undefined {
    return normalizeAnalyticsVersion(value);
}

/** Records exactly one fixed update phase transition on the serial chain. */
export function trackUpdateTransition(
    update: UpdateOperation,
    phase: UpdatePhase,
    outcome: {
        result: UpdateResult;
        source: UpdateSource;
        fromVersion?: string | null;
        toVersion?: string | null;
    }
): Promise<void> {
    if (update.closed || update.pendingCount >= MAX_PENDING_UPDATE_PHASES) {
        return update.pending;
    }
    update.pendingCount += 1;
    const fromVersion = boundedVersion(outcome.fromVersion);
    const toVersion = boundedVersion(outcome.toVersion);
    const next = update.pending
        .then(() =>
            trackAdmittedAnalytics(
                'app.update_transition',
                {
                    update_operation_id: update.updateOperationId,
                    phase,
                    result: outcome.result,
                    source: outcome.source,
                    ...(fromVersion ? { from_version: fromVersion } : {}),
                    ...(toVersion ? { to_version: toVersion } : {}),
                },
                { operation: update.operation }
            )
        )
        .then(
            () => undefined,
            () => undefined
        )
        .finally(() => {
            update.pendingCount -= 1;
        });
    update.pending = next;
    return next;
}

/**
 * Releases the update operation after its last queued phase. A terminal phase
 * (`check_finished` when the check cannot proceed, `download_finished` on
 * failure, `install_handoff` on success or failure) owns the release; callers
 * may also release an abandoned operation. Idempotent and best-effort.
 */
export async function finishUpdateOperation(update: UpdateOperation): Promise<void> {
    if (update.closed) {
        return;
    }
    await update.pending;
    if (update.closed) {
        return;
    }
    update.closed = true;
    await completeAdmittedOperation(update.operation);
}
