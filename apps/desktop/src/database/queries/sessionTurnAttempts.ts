// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { SessionTurnAttemptEntity } from '../types';

export interface SessionTurnAttemptHistoryRow {
    id: number;
    turn_id: number;
    attempt_index: number;
    max_retries: number;
    status: SessionTurnAttemptEntity['status'];
    checkpoint_json: string;
    delivery_manifest_json: string;
    error_message: string | null;
    started_at: string;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
}
