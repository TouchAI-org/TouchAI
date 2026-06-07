// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@services/NativeService';

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

export const databaseRuntime = native.database;
