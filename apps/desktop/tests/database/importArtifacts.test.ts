import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const importArtifactsRoot = resolve(process.cwd(), 'src/database/artifacts/import');
const runtimeImportSource = resolve(process.cwd(), 'src-tauri/src/core/database/runtime/import.rs');

async function readImportArtifact(name: string): Promise<string> {
    return await readFile(resolve(importArtifactsRoot, name), 'utf8');
}

describe('database import artifacts', () => {
    it('does not require memory_items in import source validation for older backups', async () => {
        const source = await readFile(runtimeImportSource, 'utf8');
        const requiredTablesBlock = source.match(/const REQUIRED_TABLES:[\s\S]+?\];/)?.[0] ?? '';

        expect(requiredTablesBlock).not.toContain('"memory_items"');
    });

    it('replaces memory_items during full import and remaps source references', async () => {
        const source = await readFile(runtimeImportSource, 'utf8');
        const postlude = await readImportArtifact('full_postlude.sql');

        expect(source).toContain('CREATE TEMP TABLE temp_imported_memory_items');
        expect(source).toContain('imported_table_exists(connection, "memory_items")');
        expect(source).toContain('FROM imported.memory_items');
        expect(postlude).not.toContain('FROM imported.memory_items');
        expect(postlude).toContain('FROM temp_imported_memory_items AS source_memory');
        expect(postlude).toContain('DELETE FROM main.memory_items');
        expect(postlude).toContain('INSERT INTO main.memory_items');
        expect(postlude).toContain('LEFT JOIN temp_session_map');
        expect(postlude).toContain('LEFT JOIN temp_message_map');
        expect(postlude).toContain('source_session_map.target_session_id');
        expect(postlude).toContain('source_message_map.target_message_id');
        expect(postlude).toContain("'memory_items'");
        expect(postlude).toContain(
            "SELECT 'memory_items', COALESCE(MAX(id), 0) FROM main.memory_items"
        );
    });
});
