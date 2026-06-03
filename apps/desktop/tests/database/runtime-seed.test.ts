import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSeedPath = path.resolve(__dirname, '../../src/database/artifacts/runtime/seed.sql');

describe('runtime seed defaults', () => {
    it('does not preseed a language row so first-launch locale detection can persist it', async () => {
        const seedSql = await readFile(runtimeSeedPath, 'utf8');

        expect(seedSql).not.toMatch(/SELECT\s+'language'\s*,/i);
    });

    it('seeds Xiaomi MiMo as the builtin managed provider on the hub API path', async () => {
        const seedSql = await readFile(runtimeSeedPath, 'utf8');

        expect(seedSql).toContain(
            "SELECT 'Xiaomi MiMo', 'mimo', 'https://hub.touch-ai.org/api/v1', NULL, json_object('touchAiMode', 'managed'), 'mimo.png', 1, 1"
        );
    });

    it('normalizes builtin Xiaomi MiMo rows into the managed hub configuration', async () => {
        const seedSql = await readFile(runtimeSeedPath, 'utf8');

        expect(seedSql).toContain(
            "SET\n    name = 'Xiaomi MiMo',\n    api_endpoint = 'https://hub.touch-ai.org/api/v1'"
        );
        expect(seedSql).toContain(
            "WHERE is_builtin = 1\n  AND driver = 'mimo'\n  AND COALESCE(json_extract(config_json, '$.touchAiMode'), 'managed') <> 'custom';"
        );
    });

    it('does not delete legacy touchai-mimo rows inside seed because runtime bootstrap handles migration safely', async () => {
        const seedSql = await readFile(runtimeSeedPath, 'utf8');

        expect(seedSql).not.toContain("DELETE FROM providers\nWHERE driver = 'touchai-mimo';");
    });
});
