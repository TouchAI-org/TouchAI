import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../../..');

async function readWorkflow(path: string) {
    return readFile(resolve(repositoryRoot, '.github/workflows', path), 'utf8');
}

describe('release workflow deployment environments', () => {
    it('keeps stable releases on the protected release environment by default', async () => {
        const workflow = await readWorkflow('velopack-build.yml');

        expect(workflow).toMatch(
            /deployment-environment:\s*\n\s+required:\s+false\s*\n\s+type:\s+string\s*\n\s+default:\s+release/
        );
        expect(workflow).toContain('environment: ${{ inputs.deployment-environment }}');
    });

    it('routes prerelease and nightly deployments to the prerelease environment', async () => {
        const workflow = await readWorkflow('release.yml');

        expect(workflow).toContain('deployment-environment: prerelease');
    });
});
