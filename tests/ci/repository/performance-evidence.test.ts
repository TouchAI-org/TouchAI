import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');
const evidencePath = join(repositoryRoot, 'docs/ci/actions-performance.md');
const floorsPath = join(repositoryRoot, 'apps/desktop/src-tauri/coverage-floors.json');

describe('user reviews the Actions performance evidence', () => {
    it('user sees Rust coverage floors match the enforced policy', async () => {
        const [evidence, floorsJson] = await Promise.all([
            readFile(evidencePath, 'utf8'),
            readFile(floorsPath, 'utf8'),
        ]);
        const floors = JSON.parse(floorsJson) as { lines: number; regions: number };

        expect(evidence).toContain(`- Rust line/region floors: ${floors.lines}/${floors.regions}.`);
    });
});
