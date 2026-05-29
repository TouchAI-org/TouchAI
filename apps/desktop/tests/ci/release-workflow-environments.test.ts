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

    it('packs Windows releases as MSI without conflicting Velopack installer flags', async () => {
        const workflow = await readWorkflow('velopack-build.yml');

        expect(workflow).toContain('--msi');
        expect(workflow).toContain('--noPortable');
        expect(workflow).not.toMatch(/--noInst[\s\S]*--noPortable|--noPortable[\s\S]*--noInst/);
    });

    it('attaches public release assets to GitHub releases from the staged asset directory', async () => {
        const workflow = await readWorkflow('velopack-build.yml');
        const uploadLine = workflow.split('\n').find((line) => line.includes('gh release upload'));

        expect(workflow).toContain('gh release upload "$RELEASE_TAG" "${assets[@]}" --clobber');
        expect(workflow).toContain('release_dir="$RUNNER_TEMP/touchai-release-assets"');
        expect(uploadLine).toBeDefined();
        expect(uploadLine ?? '').not.toContain('touchai-update-dist');
    });

    it('deploys the Cloudflare update proxy Worker with an R2 binding', async () => {
        const workflow = await readWorkflow('velopack-build.yml');

        expect(workflow).toContain('Generate Cloudflare update proxy config');
        expect(workflow).toContain(
            'node scripts/ci/write-cloudflare-update-worker-config.mjs "$wrangler_config"'
        );
        expect(workflow).toContain('Deploy Cloudflare update proxy Worker');
        expect(workflow).toContain('pnpm dlx wrangler@3.90.0 deploy');
        expect(workflow).toContain('--config "$WRANGLER_UPDATE_PROXY_CONFIG"');
    });

    it('prunes only old R2 release assets after GitHub release upload succeeds', async () => {
        const workflow = await readWorkflow('velopack-build.yml');

        expect(workflow).toContain('RELEASE_CHANNEL: ${{ inputs.channel }}');
        expect(workflow).toContain('plan-r2-release-asset-prune.mjs "$RELEASE_CHANNEL"');
        expect(workflow).toContain('wrangler@3.90.0 r2 object delete');
        expect(workflow).toMatch(
            /Upload public release assets to GitHub release[\s\S]*Deploy update release feeds to Cloudflare R2[\s\S]*Prune archived R2 release assets/
        );
    });
});
