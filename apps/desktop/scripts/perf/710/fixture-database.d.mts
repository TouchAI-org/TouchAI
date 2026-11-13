import type { DatabaseSync } from 'node:sqlite';

export function deleteStartupBookkeeping(database: DatabaseSync): void;

export function canonicalizeStartupCaches(
    source: DatabaseSync,
    target: DatabaseSync
): Record<'llm_metadata' | 'llm_metadata_aliases', number>;
