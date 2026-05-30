import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

type PlanModule = {
    planR2ReleaseAssetPrune: (
        projectRoot: string,
        channel: string,
        options?: {
            fetch?: typeof fetch;
            token?: string | null;
        }
    ) => Promise<string[]>;
};

async function loadPlanner(): Promise<PlanModule | undefined> {
    try {
        return (await import('../../scripts/ci/plan-r2-release-asset-prune.mjs')) as PlanModule;
    } catch {
        return undefined;
    }
}

async function createFixture(product: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'touchai-r2-prune-'));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'product.json'), `${JSON.stringify(product, null, 4)}\n`, 'utf8');
    return root;
}

function productWithRetention() {
    const product = JSON.parse(JSON.stringify(APP_PRODUCT_CONFIG));
    product.services.updates.deployment = {
        ...product.services.updates.deployment,
        r2HotAssetVersions: {
            stable: 2,
            beta: 2,
            nightly: 3,
        },
    };
    return product;
}

function release(tagName: string, publishedAt: string, assetNames: string[]) {
    return {
        tag_name: tagName,
        published_at: publishedAt,
        assets: assetNames.map((name) => ({ name })),
    };
}

describe('planR2ReleaseAssetPrune', () => {
    it('plans deletion for old channel assets that already exist on GitHub Releases', async () => {
        const planner = await loadPlanner();
        const product = productWithRetention();
        const root = await createFixture(product);
        const fetchMock = vi.fn<typeof fetch>(async () => {
            return new Response(
                JSON.stringify([
                    release('v0.2.0-beta.4', '2026-05-24T00:00:00Z', [
                        'TouchAI-beta-0.2.0-beta.4-windows-full.nupkg',
                    ]),
                    release('v0.2.0-beta.3', '2026-05-23T00:00:00Z', [
                        'TouchAI-beta-0.2.0-beta.3-windows-full.nupkg',
                    ]),
                    release('v0.2.0-beta.2', '2026-05-22T00:00:00Z', [
                        'TouchAI-beta-0.2.0-beta.2-windows-full.nupkg',
                        'TouchAI-beta-0.2.0-beta.2-windows-delta.nupkg',
                        'release-notes.md',
                    ]),
                    release('v0.2.0', '2026-05-21T00:00:00Z', ['TouchAI-0.2.0-windows-full.nupkg']),
                ]),
                {
                    headers: {
                        'content-type': 'application/json',
                    },
                }
            );
        });

        try {
            expect(planner?.planR2ReleaseAssetPrune).toBeTypeOf('function');
            await expect(
                planner!.planR2ReleaseAssetPrune(root, 'beta', {
                    fetch: fetchMock as unknown as typeof fetch,
                    token: 'token',
                })
            ).resolves.toEqual([
                'touchai-app/v1/TouchAI-beta-0.2.0-beta.2-windows-full.nupkg',
                'touchai-app/v1/TouchAI-beta-0.2.0-beta.2-windows-delta.nupkg',
            ]);
            expect(fetchMock).toHaveBeenCalledWith(
                'https://api.github.com/repos/TouchAI-org/TouchAI/releases?per_page=100&page=1',
                expect.objectContaining({
                    headers: expect.any(Headers),
                })
            );
            const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
            expect(headers.get('authorization')).toBe('Bearer token');
            expect(headers.get('user-agent')).toBe('touchai-r2-release-asset-prune/1.0.0');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('keeps all GitHub release assets when the channel has not exceeded its R2 retention window', async () => {
        const planner = await loadPlanner();
        const product = productWithRetention();
        const root = await createFixture(product);
        const fetchMock = vi.fn<typeof fetch>(async () => {
            return new Response(
                JSON.stringify([
                    release('v0.3.0-nightly.20260524.1', '2026-05-24T00:00:00Z', [
                        'TouchAI-nightly-0.3.0-nightly.20260524.1-windows-full.nupkg',
                    ]),
                    release('v0.3.0-nightly.20260523.1', '2026-05-23T00:00:00Z', [
                        'TouchAI-nightly-0.3.0-nightly.20260523.1-windows-full.nupkg',
                    ]),
                ]),
                { headers: { 'content-type': 'application/json' } }
            );
        });

        try {
            expect(planner?.planR2ReleaseAssetPrune).toBeTypeOf('function');
            await expect(
                planner!.planR2ReleaseAssetPrune(root, 'nightly', {
                    fetch: fetchMock as unknown as typeof fetch,
                    token: 'token',
                })
            ).resolves.toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('rejects unsupported channels before querying GitHub releases', async () => {
        const planner = await loadPlanner();
        const product = productWithRetention();
        const root = await createFixture(product);
        const fetchMock = vi.fn<typeof fetch>();

        try {
            expect(planner?.planR2ReleaseAssetPrune).toBeTypeOf('function');
            await expect(
                planner!.planR2ReleaseAssetPrune(root, 'canary', {
                    fetch: fetchMock as unknown as typeof fetch,
                    token: 'token',
                })
            ).rejects.toThrow('Unsupported release channel "canary"');
            expect(fetchMock).not.toHaveBeenCalled();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
