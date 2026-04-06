// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import type { SqlValue } from '@database/schema';
import { invoke } from '@tauri-apps/api/core';

export type DatabaseQueryMethod = 'run' | 'all' | 'get' | 'values';
export type DatabaseTransactionBehavior = 'deferred' | 'immediate' | 'exclusive';
export type DatabaseImportMode = 'chat_only' | 'full';

export interface DatabaseQueryRequest {
    sql: string;
    params?: SqlValue[];
    method: DatabaseQueryMethod;
}

export interface DatabaseQueryResponse {
    rows: Array<Record<string, unknown>>;
    rowsAffected: number;
    lastInsertId: number | null;
}

export interface DatabaseImportRequest {
    sourcePath: string;
    mode: DatabaseImportMode;
}

export const database = {
    query(request: DatabaseQueryRequest): Promise<DatabaseQueryResponse> {
        return invoke('database_query', { request });
    },

    batch(requests: DatabaseQueryRequest[]): Promise<DatabaseQueryResponse[]> {
        return invoke('database_batch', { requests });
    },

    txBegin(behavior?: DatabaseTransactionBehavior): Promise<string> {
        return invoke('database_tx_begin', { behavior });
    },

    txQuery(txId: string, request: DatabaseQueryRequest): Promise<DatabaseQueryResponse> {
        return invoke('database_tx_query', { txId, request });
    },

    txBatch(txId: string, requests: DatabaseQueryRequest[]): Promise<DatabaseQueryResponse[]> {
        return invoke('database_tx_batch', { txId, requests });
    },

    txCommit(txId: string): Promise<void> {
        return invoke('database_tx_commit', { txId });
    },

    txRollback(txId: string): Promise<void> {
        return invoke('database_tx_rollback', { txId });
    },

    exportBackup(targetPath: string): Promise<void> {
        return invoke('database_export_backup', { targetPath });
    },

    importBackup(request: DatabaseImportRequest): Promise<void> {
        return invoke('database_import_backup', { request });
    },
} as const;
