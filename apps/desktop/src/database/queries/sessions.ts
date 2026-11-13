// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { SessionCreateData, SessionEntity, SessionUpdateData } from '../types';

export interface ListSessionsOptions {
    query?: string;
    limit?: number;
}

const DEFAULT_SESSION_LIMIT = 40;
const MAX_SESSION_LIMIT = 1000;

function normalizeSessionLimit(limit?: number): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return DEFAULT_SESSION_LIMIT;
    }

    return Math.max(1, Math.min(Math.trunc(limit), MAX_SESSION_LIMIT));
}

/** Create a session through the Rust-owned transaction. */
export const createSession = async (data: SessionCreateData): Promise<SessionEntity> => {
    const createdSession = await native.database.operation<SessionEntity | null>({
        kind: 'session_create',
        data: { ...data },
    });

    if (!createdSession || createdSession.id === undefined) {
        throw new Error('Failed to create session');
    }

    return createdSession;
};

export const findSessionById = async (sessionId: number): Promise<SessionEntity | undefined> =>
    (await native.database.operation<SessionEntity | null>({
        kind: 'session_find_by_id',
        id: sessionId,
    })) ?? undefined;

export const listSessions = async (options: ListSessionsOptions = {}): Promise<SessionEntity[]> =>
    native.database.operation<SessionEntity[]>({
        kind: 'session_list',
        query: options.query?.trim().toLocaleLowerCase(),
        limit: normalizeSessionLimit(options.limit),
    });

export const dismissSessionTerminalStatus = async (sessionId: number): Promise<void> => {
    await native.database.operation({
        kind: 'session_dismiss_terminal_status',
        id: sessionId,
    });
};

export const updateSession = async ({
    id,
    sessionPatch,
}: {
    id: number;
    sessionPatch: SessionUpdateData;
}): Promise<void> => {
    await native.database.operation({
        kind: 'session_update',
        id,
        data: { ...sessionPatch },
    });
};

/** Recompute list-visible session metadata from Rust in one transaction. */
export const refreshSessionMetadata = async (sessionId: number): Promise<void> => {
    await native.database.operation({
        kind: 'session_refresh_metadata',
        id: sessionId,
    });
};

export const countSessions = async (): Promise<number> =>
    native.database.operation<number>({ kind: 'session_count' });

export const deleteAllSessions = async (): Promise<void> => {
    await native.database.operation({ kind: 'session_delete_all' });
};
