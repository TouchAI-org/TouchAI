const STARTUP_CACHE_TABLES = ['llm_metadata', 'llm_metadata_aliases'];

function quoteIdentifier(value) {
    return `"${String(value).replaceAll('"', '""')}"`;
}

function tableColumns(database, table) {
    return database
        .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all()
        .map((column) => String(column.name));
}

function copyTableRows(source, target, table) {
    const sourceColumns = tableColumns(source, table);
    const targetColumns = new Set(tableColumns(target, table));
    const columns = sourceColumns.filter((column) => targetColumns.has(column));
    if (columns.length === 0) {
        throw new Error(`Fixture startup cache '${table}' has no comparable columns`);
    }

    const quotedTable = quoteIdentifier(table);
    const columnList = columns.map(quoteIdentifier).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const rows = source.prepare(`SELECT ${columnList} FROM ${quotedTable}`).all();
    target.exec(`DELETE FROM ${quotedTable}`);
    const insert = target.prepare(
        `INSERT INTO ${quotedTable} (${columnList}) VALUES (${placeholders})`
    );
    for (const row of rows) {
        insert.run(...columns.map((column) => row[column]));
    }
    return rows.length;
}

export function deleteStartupBookkeeping(database) {
    database.exec('DELETE FROM "statistics"');
}

/**
 * Copies the baseline's deterministic bundled metadata into the current arm.
 *
 * Baseline startup seeds the bundled snapshot while the current E2E bootstrap
 * intentionally skips network-backed metadata initialization. Both measured
 * binaries must nevertheless start from the same database state.
 */
export function canonicalizeStartupCaches(source, target) {
    const metadataCount = Number(
        source.prepare('SELECT COUNT(*) AS count FROM "llm_metadata"').get().count
    );
    if (metadataCount === 0) {
        throw new Error('Baseline model metadata cache did not settle before fixture capture');
    }

    target.exec('BEGIN IMMEDIATE');
    try {
        const copied = Object.fromEntries(
            STARTUP_CACHE_TABLES.map((table) => [table, copyTableRows(source, target, table)])
        );
        deleteStartupBookkeeping(target);
        target.exec('COMMIT');
        return copied;
    } catch (error) {
        target.exec('ROLLBACK');
        throw error;
    }
}
