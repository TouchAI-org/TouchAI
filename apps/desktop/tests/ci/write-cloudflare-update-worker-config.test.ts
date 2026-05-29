import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

type ConfigModule = {
    buildCloudflareUpdateWorkerConfig: (
        product: unknown,
        options: { workerScriptPath: string }
    ) => string;
    writeCloudflareUpdateWorkerConfig: (projectRoot: string, outputPath: string) => Promise<void>;
};

async function loadConfigModule(): Promise<ConfigModule | undefined> {
    try {
        return (await import('../../scripts/ci/write-cloudflare-update-worker-config.mjs')) as ConfigModule;
    } catch {
        return undefined;
    }
}

async function createFixture(product: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'touchai-worker-config-'));
    await writeFile(join(root, 'product.json'), `${JSON.stringify(product, null, 4)}\n`, 'utf8');
    return root;
}

describe('writeCloudflareUpdateWorkerConfig', () => {
    it('builds wrangler config from product.json update deployment settings', async () => {
        const module = await loadConfigModule();

        expect(module?.buildCloudflareUpdateWorkerConfig).toBeTypeOf('function');
        const config = module!.buildCloudflareUpdateWorkerConfig(APP_PRODUCT_CONFIG, {
            workerScriptPath: 'scripts/cloudflare/update-proxy-worker.mjs',
        });

        expect(config).toContain(`name = "touchai-update-proxy"`);
        expect(config).toContain(`binding = "UPDATE_BUCKET"`);
        expect(config).toContain(`UPDATE_BASE_PATH = "touchai-app/v1"`);
        expect(config).toContain(`GITHUB_REPOSITORY = "TouchAI-org/TouchAI"`);
    });

    it('writes a config whose Worker main path is relative to the output file', async () => {
        const module = await loadConfigModule();
        const root = await createFixture(APP_PRODUCT_CONFIG);
        const outputPath = join(root, '.generated', 'wrangler.toml');

        try {
            expect(module?.writeCloudflareUpdateWorkerConfig).toBeTypeOf('function');
            await module!.writeCloudflareUpdateWorkerConfig(root, outputPath);

            await expect(readFile(outputPath, 'utf8')).resolves.toContain(
                `main = "../scripts/cloudflare/update-proxy-worker.mjs"`
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
