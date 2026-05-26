import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type NormalizeTauriBundleAssets = (
    projectRoot: string,
    releaseDir: string,
    options: { channel: string; version: string }
) => Promise<void>;

async function loadNormalizer(): Promise<NormalizeTauriBundleAssets | undefined> {
    try {
        const module = await import('../../scripts/ci/normalize-tauri-bundle-assets.mjs');
        return module.normalizeTauriBundleAssets as NormalizeTauriBundleAssets;
    } catch {
        return undefined;
    }
}

async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-tauri-assets-'));
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

describe('normalizeTauriBundleAssets', () => {
    it('renames macOS and Linux bundle assets to public names', async () => {
        const normalizeTauriBundleAssets = await loadNormalizer();
        const { root, releaseDir } = await createFixture();

        await writeFile(join(releaseDir, 'touchai_0.2.0_x64.dmg'), 'dmg');
        await writeFile(join(releaseDir, 'touchai.app.tar.gz'), 'mac-updater');
        await writeFile(join(releaseDir, 'touchai_0.2.0_amd64.AppImage'), 'appimage');
        await writeFile(join(releaseDir, 'touchai.AppImage.tar.gz'), 'linux-updater');
        await writeFile(join(releaseDir, 'touchai_0.2.0_amd64.deb'), 'deb');
        await writeFile(join(releaseDir, 'touchai-0.2.0-1.x86_64.rpm'), 'rpm');

        try {
            expect(normalizeTauriBundleAssets).toBeTypeOf('function');
            await normalizeTauriBundleAssets?.(root, releaseDir, {
                channel: 'beta',
                version: '0.2.0-beta.1',
            });

            await expect(
                readFile(join(releaseDir, 'TouchAI-beta-0.2.0-beta.1-macos.dmg'), 'utf8')
            ).resolves.toBe('dmg');
            await expect(
                readFile(join(releaseDir, 'TouchAI-beta-0.2.0-beta.1-macos.app.tar.gz'), 'utf8')
            ).resolves.toBe('mac-updater');
            await expect(
                readFile(join(releaseDir, 'TouchAI-beta-0.2.0-beta.1-linux.AppImage'), 'utf8')
            ).resolves.toBe('appimage');
            await expect(
                readFile(
                    join(releaseDir, 'TouchAI-beta-0.2.0-beta.1-linux.AppImage.tar.gz'),
                    'utf8'
                )
            ).resolves.toBe('linux-updater');
            await expect(
                readFile(join(releaseDir, 'TouchAI-beta-0.2.0-beta.1-linux-amd64.deb'), 'utf8')
            ).resolves.toBe('deb');
            await expect(
                readFile(join(releaseDir, 'TouchAI-beta-0.2.0-beta.1-linux-x86_64.rpm'), 'utf8')
            ).resolves.toBe('rpm');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
