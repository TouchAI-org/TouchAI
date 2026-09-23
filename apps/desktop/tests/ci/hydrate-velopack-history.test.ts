import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

type HydrateVelopackHistory = (
    projectRoot: string,
    releaseDir: string,
    channel: string
) => Promise<void>;

async function loadHydrator(): Promise<HydrateVelopackHistory | undefined> {
    try {
        const module = await import('../../scripts/ci/hydrate-velopack-history.mjs');
        return module.hydrateVelopackHistory as HydrateVelopackHistory;
    } catch {
        return undefined;
    }
}

async function createFixture(product: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'touchai-velopack-history-'));
    await writeFile(join(root, 'product.json'), `${JSON.stringify(product, null, 4)}\n`, 'utf8');
    return root;
}

function productWithNightlyRetention(keepVersions: number) {
    const product = JSON.parse(JSON.stringify(APP_PRODUCT_CONFIG));
    product.services.updates.deployment = {
        ...product.services.updates.deployment,
        r2HotAssetVersions: {
            stable: 2,
            beta: 2,
            nightly: keepVersions,
        },
    };
    return product;
}

function release(tagName: string, publishedAt: string) {
    return {
        tag_name: tagName,
        published_at: publishedAt,
        assets: [],
    };
}

async function exists(path: string) {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

describe('hydrateVelopackHistory', () => {
    it('keeps only retained GitHub release versions from the existing channel feed', async () => {
        const hydrateVelopackHistory = await loadHydrator();
        const product = productWithNightlyRetention(2);
        const root = await createFixture(product);
        const releaseDir = join(root, 'release');
        const feedUrl = `${product.services.updates.baseUrl}/releases.nightly.json`;
        const keptPackage = 'TouchAI-nightly-0.3.0-nightly.20260523.3-windows-full.nupkg';
        const oldPackage = 'TouchAI-nightly-0.3.0-nightly.20260522.2-windows-full.nupkg';
        const orphanPackage = 'TouchAI-nightly-0.3.0-nightly.20260521.1-windows-full.nupkg';
        const feed = {
            Assets: [
                {
                    PackageId: product.identifier,
                    Version: '0.3.0-nightly.20260523.3',
                    Type: 'Full',
                    FileName: keptPackage,
                },
                {
                    PackageId: product.identifier,
                    Version: '0.3.0-nightly.20260522.2',
                    Type: 'Full',
                    FileName: oldPackage,
                },
                {
                    PackageId: product.identifier,
                    Version: '0.3.0-nightly.20260521.1',
                    Type: 'Full',
                    FileName: orphanPackage,
                },
            ],
        };
        const fetchMock = vi.fn<typeof fetch>(async (input) => {
            const url = input.toString();

            if (url === feedUrl) {
                return new Response(JSON.stringify(feed), {
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (new URL(url).hostname === 'api.github.com') {
                return new Response(
                    JSON.stringify([
                        release('v0.3.0-nightly.20260524.4', '2026-05-24T00:00:00Z'),
                        release('v0.3.0-nightly.20260523.3', '2026-05-23T00:00:00Z'),
                        release('v0.3.0-nightly.20260522.2', '2026-05-22T00:00:00Z'),
                    ]),
                    { headers: { 'content-type': 'application/json' } }
                );
            }

            if (url.endsWith(keptPackage)) {
                return new Response('kept package');
            }

            return new Response(null, { status: 404 });
        });
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fetchMock as unknown as typeof fetch;

        try {
            await mkdir(releaseDir, { recursive: true });
            expect(hydrateVelopackHistory).toBeTypeOf('function');
            await hydrateVelopackHistory?.(root, releaseDir, 'nightly');

            const hydratedFeed = JSON.parse(
                await readFile(join(releaseDir, 'releases.nightly.json'), 'utf8')
            );
            expect(
                hydratedFeed.Assets.map((asset: { FileName: string }) => asset.FileName)
            ).toEqual([keptPackage]);
            await expect(readFile(join(releaseDir, keptPackage), 'utf8')).resolves.toBe(
                'kept package'
            );
            await expect(exists(join(releaseDir, oldPackage))).resolves.toBe(false);
            await expect(exists(join(releaseDir, orphanPackage))).resolves.toBe(false);
            expect(fetchMock).not.toHaveBeenCalledWith(
                `${product.services.updates.baseUrl}/${oldPackage}`
            );
            expect(fetchMock).not.toHaveBeenCalledWith(
                `${product.services.updates.baseUrl}/${orphanPackage}`
            );
        } finally {
            globalThis.fetch = originalFetch;
            await rm(root, { recursive: true, force: true });
        }
    });
});
