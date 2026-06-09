import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeSeedPath = path.resolve(__dirname, '../../src/database/artifacts/runtime/seed.sql');

describe('App Use runtime seed defaults', () => {
    it('seeds App Use tools disabled by default as high-risk tools', async () => {
        const seedSql = await readFile(runtimeSeedPath, 'utf8');

        for (const toolId of ['app_session', 'app_observe', 'app_act']) {
            expect(seedSql).toContain(`SELECT '${toolId}'`);
        }
        expect(seedSql).toContain("'AppSession', '软件控制：发现本地应用与能力', 0, 'high'");
        expect(seedSql).toContain("'AppObserve', '软件控制：读取本地应用上下文', 0, 'high'");
        expect(seedSql).toContain("'AppAct', '软件控制：执行一个受控应用动作', 0, 'high'");
    });
});
