import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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

async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-velopack-history-'));
    const releaseDir = join(root, 'release');
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
        join(root, 'product.json'),
        JSON.stringify(
            {
                schemaVersion: 1,
                services: {
                    updates: {
                        baseUrl: 'https://updates.example.test/touchai-app/v1',
                    },
                },
            },
            null,
            4
        )
    );
    return { root, releaseDir };
}

function createFetchMock() {
    const safeFileName = 'TouchAI-beta-0.2.0-beta.1-windows-full.nupkg';
    const unsafeFileName = '../escape.nupkg';
    const feed = {
        Assets: [
            { FileName: safeFileName, Type: 'Full' },
            { FileName: unsafeFileName, Type: 'Full' },
            { FileName: 'release-notes.md', Type: 'Notes' },
        ],
    };

    return {
        safeFileName,
        unsafeFileName,
        fetchMock: vi.fn(async (input: string | URL | Request) => {
            const url = input.toString();
            if (url.endsWith('/releases.beta.json')) {
                return new Response(JSON.stringify(feed), {
                    headers: { 'content-type': 'application/json' },
                });
            }
            if (url.endsWith(`/${encodeURIComponent(safeFileName)}`)) {
                return new Response('safe package');
            }

            return new Response('not found', { status: 404 });
        }) as unknown as typeof fetch,
    };
}

describe('hydrateVelopackHistory', () => {
    it('hydrates only safe package file names from an existing feed', async () => {
        const hydrateVelopackHistory = await loadHydrator();
        const { root, releaseDir } = await createFixture();
        const { safeFileName, unsafeFileName, fetchMock } = createFetchMock();
        const originalFetch = globalThis.fetch;
        globalThis.fetch = fetchMock;

        try {
            expect(hydrateVelopackHistory).toBeTypeOf('function');
            await hydrateVelopackHistory?.(root, releaseDir, 'beta');

            await expect(readFile(join(releaseDir, safeFileName), 'utf8')).resolves.toBe(
                'safe package'
            );
            await expect(readFile(join(root, 'escape.nupkg'), 'utf8')).rejects.toMatchObject({
                code: 'ENOENT',
            });

            const hydratedFeed = JSON.parse(
                await readFile(join(releaseDir, 'releases.beta.json'), 'utf8')
            );
            expect(
                hydratedFeed.Assets.map((asset: { FileName: string }) => asset.FileName)
            ).toEqual([safeFileName]);
            expect(fetchMock).not.toHaveBeenCalledWith(
                expect.stringContaining(encodeURIComponent(unsafeFileName)),
                expect.anything()
            );
        } finally {
            globalThis.fetch = originalFetch;
            await rm(root, { recursive: true, force: true });
        }
    });
});
