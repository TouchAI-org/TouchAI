import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type StageReleaseUploadAssets = (
    releaseDir: string,
    outputDir: string,
    options: { version: string }
) => Promise<string[]>;

async function loadStager(): Promise<StageReleaseUploadAssets | undefined> {
    try {
        const module = await import('../../scripts/ci/stage-release-upload-assets.mjs');
        return module.stageReleaseUploadAssets as StageReleaseUploadAssets;
    } catch {
        return undefined;
    }
}

async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-release-upload-assets-'));
    const releaseDir = join(root, 'release');
    const outputDir = join(root, 'github-release');
    await mkdir(releaseDir, { recursive: true });
    return { root, releaseDir, outputDir };
}

describe('stageReleaseUploadAssets', () => {
    it('copies only current-version download assets for the GitHub release archive', async () => {
        const stageReleaseUploadAssets = await loadStager();
        const { root, releaseDir, outputDir } = await createFixture();
        const copiedNames = [
            'TouchAI-1.2.0-windows.msi',
            'TouchAI-1.2.0-windows-full.nupkg',
            'TouchAI-1.2.0-windows-delta.nupkg',
            'TouchAI-1.2.0-macos.dmg',
            'TouchAI-1.2.0-linux.AppImage',
        ];
        const ignoredNames = [
            'TouchAI-1.1.1-windows-full.nupkg',
            'TouchAI-1.1.1-windows-delta.nupkg',
            'TouchAI-beta-1.3.0-beta.1-windows-full.nupkg',
            'releases.stable.json',
            'RELEASES',
            'random.txt',
        ];

        for (const name of [...copiedNames, ...ignoredNames]) {
            await writeFile(join(releaseDir, name), `asset:${name}`, 'utf8');
        }
        const expectedCopiedNames = [...copiedNames].sort((left, right) =>
            left.localeCompare(right)
        );

        try {
            expect(stageReleaseUploadAssets).toBeTypeOf('function');
            await expect(
                stageReleaseUploadAssets?.(releaseDir, outputDir, { version: '1.2.0' })
            ).resolves.toEqual(expectedCopiedNames);

            await expect(readdir(outputDir).then((names) => names.sort())).resolves.toEqual(
                expectedCopiedNames
            );
            for (const name of copiedNames) {
                await expect(readFile(join(outputDir, name), 'utf8')).resolves.toBe(
                    `asset:${name}`
                );
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('fails fast when a release has no current-version download assets', async () => {
        const stageReleaseUploadAssets = await loadStager();
        const { root, releaseDir, outputDir } = await createFixture();

        await writeFile(join(releaseDir, 'TouchAI-1.1.1-windows-full.nupkg'), 'old', 'utf8');
        await writeFile(join(releaseDir, 'releases.stable.json'), '{}', 'utf8');

        try {
            expect(stageReleaseUploadAssets).toBeTypeOf('function');
            await expect(
                stageReleaseUploadAssets?.(releaseDir, outputDir, { version: '1.2.0' })
            ).rejects.toThrow('No current-version release assets found for 1.2.0.');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
