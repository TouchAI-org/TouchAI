// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { and, asc, eq } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { sessionTurnContextArtifacts, sessionTurns } from '../schema';
import type {
    SessionTurnContextArtifactCreateData,
    SessionTurnContextArtifactEntity,
} from '../types';

export interface SessionTurnContextArtifactHistoryRow extends SessionTurnContextArtifactEntity {
    prompt_message_id: number | null;
}

export async function createSessionTurnContextArtifact(
    data: SessionTurnContextArtifactCreateData,
    database: DatabaseExecutor = db
): Promise<SessionTurnContextArtifactEntity> {
    const row = await database
        .insert(sessionTurnContextArtifacts)
        .values(data)
        .onConflictDoUpdate({
            target: [
                sessionTurnContextArtifacts.turn_id,
                sessionTurnContextArtifacts.capsule_id,
                sessionTurnContextArtifacts.artifact_kind,
            ],
            set: {
                artifact_path: data.artifact_path ?? null,
                mime_type: data.mime_type ?? null,
                width: data.width ?? null,
                height: data.height ?? null,
                captured_at: data.captured_at,
                metadata_json: data.metadata_json ?? null,
            },
        })
        .returning()
        .get();

    if (row && row.id !== undefined) {
        return row;
    }

    const existing = await database
        .select()
        .from(sessionTurnContextArtifacts)
        .where(
            and(
                eq(sessionTurnContextArtifacts.turn_id, data.turn_id),
                eq(sessionTurnContextArtifacts.capsule_id, data.capsule_id),
                eq(sessionTurnContextArtifacts.artifact_kind, data.artifact_kind)
            )
        )
        .get();

    if (!existing) {
        throw new Error('Failed to create session turn context artifact');
    }

    return existing;
}

export async function findSessionTurnContextArtifactsBySessionId(
    sessionId: number
): Promise<SessionTurnContextArtifactHistoryRow[]> {
    return db
        .select({
            id: sessionTurnContextArtifacts.id,
            turn_id: sessionTurnContextArtifacts.turn_id,
            prompt_message_id: sessionTurns.prompt_message_id,
            capsule_id: sessionTurnContextArtifacts.capsule_id,
            artifact_kind: sessionTurnContextArtifacts.artifact_kind,
            artifact_path: sessionTurnContextArtifacts.artifact_path,
            mime_type: sessionTurnContextArtifacts.mime_type,
            width: sessionTurnContextArtifacts.width,
            height: sessionTurnContextArtifacts.height,
            captured_at: sessionTurnContextArtifacts.captured_at,
            metadata_json: sessionTurnContextArtifacts.metadata_json,
            created_at: sessionTurnContextArtifacts.created_at,
        })
        .from(sessionTurnContextArtifacts)
        .innerJoin(sessionTurns, eq(sessionTurns.id, sessionTurnContextArtifacts.turn_id))
        .where(eq(sessionTurns.session_id, sessionId))
        .orderBy(asc(sessionTurnContextArtifacts.created_at), asc(sessionTurnContextArtifacts.id))
        .all();
}
