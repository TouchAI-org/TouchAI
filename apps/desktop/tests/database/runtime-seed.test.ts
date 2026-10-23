import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSeedPath = path.resolve(__dirname, '../../src/database/artifacts/runtime/seed.sql');

describe('when the app starts for the first time', () => {
    it('user gets a language chosen from their system instead of a hard-coded default', async () => {
        const seedSql = await readFile(runtimeSeedPath, 'utf8');

        expect(seedSql).not.toMatch(/SELECT\s+'language'\s*,/i);
    });

    it('user sees the web discovery and browser control tools available', async () => {
        const seedSql = await readFile(runtimeSeedPath, 'utf8');

        expect(seedSql).toContain("SELECT 'web_search', 'WebSearch'");
        expect(seedSql).toContain("SELECT 'web_fetch', 'WebFetch'");
        expect(seedSql).toContain("SELECT 'browser', 'Browser'");
        expect(seedSql).not.toContain("SELECT 'browser_session'");
        expect(seedSql).not.toContain("SELECT 'browser_observe'");
        expect(seedSql).not.toContain("SELECT 'browser_act'");
    });

    it('user can run shell commands but is asked first for risky ones', async () => {
        const seedSql = await readFile(runtimeSeedPath, 'utf8');

        expect(seedSql).toMatch(/SELECT\s+'bash',\s+'Bash',[\s\S]*?,\s+1,\s+'high'/);
        expect(seedSql).toContain('"approvalMode":"high_risk"');
    });
});
