import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type NormalizeVelopackReleaseAssets = (
    projectRoot: string,
    releaseDir: string,
    options: { channel: string; version: string }
) => Promise<void>;

async function loadNormalizer(): Promise<NormalizeVelopackReleaseAssets | undefined> {
    try {
        const module = await import('../../scripts/ci/normalize-velopack-release-assets.mjs');
        return module.normalizeVelopackReleaseAssets as NormalizeVelopackReleaseAssets;
    } catch {
        return undefined;
    }
}

async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-velopack-assets-'));
    const releaseDir = join(root, 'release');
    await mkdir(releaseDir, { recursive: true });
    await writeFile(
        join(root, 'product.json'),
        JSON.stringify(
            {
                schemaVersion: 1,
                displayName: 'TouchAI',
                identifier: 'org.touch-ai.app',
            },
            null,
            4
        )
    );
    return { root, releaseDir };
}

describe('normalizeVelopackReleaseAssets', () => {
    it('renames current beta packages and MSI while dropping setup and portable artifacts', async () => {
        const normalizeVelopackReleaseAssets = await loadNormalizer();
        const { root, releaseDir } = await createFixture();
        const previousFull = 'org.touch-ai.app-0.1.0-beta-full.nupkg';
        const currentFull = 'org.touch-ai.app-0.1.1-beta.1-beta-full.nupkg';
        const currentDelta = 'org.touch-ai.app-0.1.1-beta.1-beta-delta.nupkg';
        const currentMsi = 'org.touch-ai.app-beta.msi';
        const currentSetup = 'org.touch-ai.app-beta-Setup.exe';
        const currentPortable = 'org.touch-ai.app-beta-Portable.zip';

        await writeFile(join(releaseDir, previousFull), 'previous');
        await writeFile(join(releaseDir, currentFull), 'full');
        await writeFile(join(releaseDir, currentDelta), 'delta');
        await writeFile(join(releaseDir, currentMsi), 'msi');
        await writeFile(join(releaseDir, currentSetup), 'setup');
        await writeFile(join(releaseDir, currentPortable), 'portable');
        await writeFile(
            join(releaseDir, 'releases.beta.json'),
            JSON.stringify(
                {
                    Assets: [
                        {
                            PackageId: 'org.touch-ai.app',
                            Version: '0.1.1-beta.1',
                            Type: 'Full',
                            FileName: currentFull,
                        },
                        {
                            PackageId: 'org.touch-ai.app',
                            Version: '0.1.1-beta.1',
                            Type: 'Delta',
                            FileName: currentDelta,
                        },
                        {
                            PackageId: 'org.touch-ai.app',
                            Version: '0.1.0',
                            Type: 'Full',
                            FileName: previousFull,
                        },
                    ],
                },
                null,
                4
            )
        );
        await writeFile(
            join(releaseDir, 'assets.beta.json'),
            JSON.stringify(
                [
                    { RelativeFileName: currentFull, Type: 1 },
                    { RelativeFileName: currentDelta, Type: 2 },
                    { RelativeFileName: currentMsi, Type: 5 },
                    { RelativeFileName: currentSetup, Type: 4 },
                    { RelativeFileName: currentPortable, Type: 3 },
                ],
                null,
                4
            )
        );
        await writeFile(
            join(releaseDir, 'RELEASES-beta'),
            [`123 ${currentFull} 100`, `456 ${currentDelta} 50`, `789 ${previousFull} 90`, ''].join(
                '\n'
            )
        );

        try {
            expect(normalizeVelopackReleaseAssets).toBeTypeOf('function');
            await normalizeVelopackReleaseAssets?.(root, releaseDir, {
                channel: 'beta',
                version: '0.1.1-beta.1',
            });

            const renamedFull = 'TouchAI-beta-0.1.1-beta.1-windows-full.nupkg';
            const renamedDelta = 'TouchAI-beta-0.1.1-beta.1-windows-delta.nupkg';
            const renamedMsi = 'TouchAI-beta-0.1.1-beta.1-windows.msi';
            const releases = JSON.parse(
                await readFile(join(releaseDir, 'releases.beta.json'), 'utf8')
            );
            const assets = JSON.parse(await readFile(join(releaseDir, 'assets.beta.json'), 'utf8'));
            const legacyReleases = await readFile(join(releaseDir, 'RELEASES-beta'), 'utf8');

            await expect(readFile(join(releaseDir, renamedFull), 'utf8')).resolves.toBe('full');
            await expect(readFile(join(releaseDir, renamedDelta), 'utf8')).resolves.toBe('delta');
            await expect(readFile(join(releaseDir, renamedMsi), 'utf8')).resolves.toBe('msi');
            await expect(readFile(join(releaseDir, currentFull), 'utf8')).rejects.toMatchObject({
                code: 'ENOENT',
            });
            await expect(readFile(join(releaseDir, currentSetup), 'utf8')).rejects.toMatchObject({
                code: 'ENOENT',
            });
            await expect(readFile(join(releaseDir, currentPortable), 'utf8')).rejects.toMatchObject(
                {
                    code: 'ENOENT',
                }
            );
            await expect(readFile(join(releaseDir, previousFull), 'utf8')).resolves.toBe(
                'previous'
            );
            expect(releases.Assets[0]).toMatchObject({
                PackageId: 'org.touch-ai.app',
                FileName: renamedFull,
            });
            expect(releases.Assets[1]).toMatchObject({
                PackageId: 'org.touch-ai.app',
                FileName: renamedDelta,
            });
            expect(releases.Assets[2]).toMatchObject({ FileName: previousFull });
            expect(
                assets.map((asset: { RelativeFileName: string }) => asset.RelativeFileName)
            ).toEqual([renamedFull, renamedDelta, renamedMsi]);
            expect(legacyReleases).toContain(renamedFull);
            expect(legacyReleases).toContain(renamedDelta);
            expect(legacyReleases).toContain(previousFull);
            expect(legacyReleases).not.toContain(currentSetup);
            expect(legacyReleases).not.toContain(currentPortable);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('omits the stable channel from public artifact names', async () => {
        const normalizeVelopackReleaseAssets = await loadNormalizer();
        const { root, releaseDir } = await createFixture();

        await writeFile(join(releaseDir, 'org.touch-ai.app-0.2.0-full.nupkg'), 'full');
        await writeFile(join(releaseDir, 'org.touch-ai.app.msi'), 'msi');
        await writeFile(join(releaseDir, 'org.touch-ai.app-Setup.exe'), 'setup');
        await writeFile(join(releaseDir, 'org.touch-ai.app-Portable.zip'), 'portable');

        try {
            expect(normalizeVelopackReleaseAssets).toBeTypeOf('function');
            await normalizeVelopackReleaseAssets?.(root, releaseDir, {
                channel: 'stable',
                version: '0.2.0',
            });

            await expect(
                readFile(join(releaseDir, 'TouchAI-0.2.0-windows-full.nupkg'), 'utf8')
            ).resolves.toBe('full');
            await expect(
                readFile(join(releaseDir, 'TouchAI-0.2.0-windows.msi'), 'utf8')
            ).resolves.toBe('msi');
            await expect(
                readFile(join(releaseDir, 'org.touch-ai.app-Setup.exe'), 'utf8')
            ).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(
                readFile(join(releaseDir, 'org.touch-ai.app-Portable.zip'), 'utf8')
            ).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
