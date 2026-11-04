// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import type { SqlValue } from '@database/schema';

import { invoke } from './invoke';

export type DatabaseOperation =
    | { kind: 'setting_find'; key: string }
    | { kind: 'setting_get'; key: string }
    | { kind: 'setting_set'; key: string; value: string }
    | { kind: 'statistic_get'; key: string }
    | { kind: 'statistic_set'; key: string; value: string }
    | { kind: 'meta_get'; key: string }
    | { kind: 'meta_set'; key: string; value: string }
    | { kind: 'meta_delete'; key: string }
    | { kind: 'quick_search_find'; queryNorm: string; limit: number }
    | {
          kind: 'quick_search_upsert';
          queryNorm: string;
          pathNorm: string;
          maxClickCount: number;
      };

export interface DatabaseOperationError {
    code: string;
    message: string;
}

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
    operation<T>(request: DatabaseOperation): Promise<T> {
        return invoke<T>('database_operation', { request }).catch((error: unknown) => {
            const normalized = normalizeDatabaseOperationError(error);
            throw normalized;
        });
    },

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

function normalizeDatabaseOperationError(error: unknown): Error {
    if (error instanceof Error) {
        return error;
    }
    if (error && typeof error === 'object') {
        const value = error as Partial<DatabaseOperationError>;
        if (typeof value.message === 'string') {
            const normalized = new Error(value.message);
            if (typeof value.code === 'string') {
                (normalized as Error & { code?: string }).code = value.code;
            }
            return normalized;
        }
    }
    return new Error(String(error));
}
