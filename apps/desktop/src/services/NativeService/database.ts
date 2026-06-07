// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { invoke } from '@tauri-apps/api/core';

import type {
    DatabaseImportRequest,
    DatabaseQueryRequest,
    DatabaseQueryResponse,
    DatabaseTransactionBehavior,
} from '@/contracts/databaseRuntime';

export type {
    DatabaseImportMode,
    DatabaseImportRequest,
    DatabaseQueryMethod,
    DatabaseQueryRequest,
    DatabaseQueryResponse,
    DatabaseTransactionBehavior,
    SqlParams,
    SqlValue,
} from '@/contracts/databaseRuntime';

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
