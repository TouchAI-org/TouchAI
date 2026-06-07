// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@services/NativeService';

export type {
    DatabaseImportMode,
    DatabaseImportRequest,
    DatabaseQueryMethod,
    DatabaseQueryRequest,
    DatabaseQueryResponse,
    DatabaseTransactionBehavior,
} from '@services/NativeService/database';

export const databaseRuntime = native.database;
