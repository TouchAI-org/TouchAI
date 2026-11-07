// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { log } from '@services/ObservabilityService';
import type { Logger } from 'drizzle-orm/logger';

// Parameters can contain large tool output and credentials. Log only statement shape and count.
const MAX_SQL_LENGTH = 400;

export function createSqlLogger(): Logger {
    return {
        logQuery(query, params) {
            const sql =
                query.length > MAX_SQL_LENGTH ? `${query.slice(0, MAX_SQL_LENGTH)}…` : query;

            log.debug(`Query: ${sql} -- params: ${params.length}`);
        },
    };
}
