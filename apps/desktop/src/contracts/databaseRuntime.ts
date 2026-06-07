// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export type SqlValue = string | number | boolean | null | Uint8Array;
export type SqlParams = SqlValue[];

export type DatabaseQueryMethod = 'run' | 'all' | 'get' | 'values';
export type DatabaseTransactionBehavior = 'deferred' | 'immediate' | 'exclusive';
export type DatabaseImportMode = 'chat_only' | 'full';

export interface DatabaseQueryRequest {
    sql: string;
    params?: SqlParams;
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
