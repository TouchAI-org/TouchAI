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
});
