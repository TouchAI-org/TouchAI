// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { analytics } from './index';
import type { AnalyticsOperationHandle } from './types';

/**
 * App update lifecycle instrumentation.
 *
 * One random update operation id spans every normal phase of a single update
 * decision, so check/download/handoff transitions correlate without reusing a
 * version string or a database id. `restart_confirmed` is native-owned: the
 * runtime records a bounded pending update on a successful install handoff and
 * confirms it once, only after a later start observes the target version, so a
 * handoff is never reported as a completed update. Download progress chunks are
 * deliberately not emitted.
 */

export type UpdatePhase =
    | 'check_started'
    | 'check_finished'
    | 'download_started'
    | 'download_finished'
    | 'install_handoff'
    | 'restart_confirmed';
export type UpdateSource = 'background' | 'user' | 'other';
export type UpdateResult = 'success' | 'failure' | 'unavailable';

export interface UpdateOperation {
    operation: AnalyticsOperationHandle;
    updateOperationId: string;
}

/** Opens a bounded update operation when a real update decision starts. */
export async function beginUpdateOperation(): Promise<UpdateOperation> {
    return {
        operation: await analytics.beginOperation(),
        updateOperationId: crypto.randomUUID(),
    };
}

/** Sanitizes a version into the bounded version string the schema accepts. */
export function boundedVersion(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : undefined;
}

/** Records exactly one fixed update phase transition. */
export async function trackUpdateTransition(
    update: UpdateOperation,
    phase: UpdatePhase,
    outcome: {
        result: UpdateResult;
        source: UpdateSource;
        fromVersion?: string | null;
        toVersion?: string | null;
    }
): Promise<void> {
    const fromVersion = boundedVersion(outcome.fromVersion);
    const toVersion = boundedVersion(outcome.toVersion);
    await analytics.track(
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
    );
}
