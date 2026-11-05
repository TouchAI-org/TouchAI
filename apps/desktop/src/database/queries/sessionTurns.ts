// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { SessionTurnEntity } from '../types';

export interface SessionTurnHistoryRow {
    id: number;
    session_id: number | null;
    task_id: string;
    execution_mode: SessionTurnEntity['execution_mode'];
    prompt_snapshot_json: string;
    prompt_message_id: number | null;
    response_message_id: number | null;
    status: SessionTurnEntity['status'];
    error_message: string | null;
    created_at: string;
    updated_at: string;
}

export const countSessionTurns = async (): Promise<number> =>
    native.database.operation<number>({ kind: 'session_turn_count' });

export const deleteAllSessionTurns = async (): Promise<void> => {
    await native.database.operation({ kind: 'session_turn_delete_all' });
};
