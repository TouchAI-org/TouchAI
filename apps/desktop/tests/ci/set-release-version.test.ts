import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

type SetReleaseVersion = (projectRoot: string, version: string) => Promise<void>;

async function loadSetter(): Promise<SetReleaseVersion | undefined> {
    try {
        const module = await import('../../scripts/ci/set-release-version.mjs');
        return module.setReleaseVersion as SetReleaseVersion;
    } catch {
        return undefined;
    }
}

async function createFixture() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-set-release-version-'));
    const tauriRoot = join(root, 'src-tauri');
    await mkdir(tauriRoot, { recursive: true });
    await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'touchai', version: '1.2.3' }, null, 4)
    );
    await writeFile(
        join(tauriRoot, 'tauri.conf.json'),
        JSON.stringify({ productName: 'TouchAI', version: '1.2.3' }, null, 4)
    );
    await writeFile(
        join(tauriRoot, 'Cargo.toml'),
        [
            '[package]',
            'name = "touchai"',
            'version = "1.2.3"',
            '',
            '[build-dependencies]',
            'tauri-codegen = "2.6"',
            '',
        ].join('\n')
    );
    return root;
}

describe('setReleaseVersion', () => {
    it('updates all app manifests and only the Cargo package version', async () => {
        const setReleaseVersion = await loadSetter();
        const root = await createFixture();

        try {
            expect(setReleaseVersion).toBeTypeOf('function');
            await setReleaseVersion?.(root, '1.2.3-nightly.20260522.42.1');

            const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
            const tauriConfig = JSON.parse(
                await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')
            );
            const cargoToml = await readFile(join(root, 'src-tauri', 'Cargo.toml'), 'utf8');

            expect(packageJson.version).toBe('1.2.3-nightly.20260522.42.1');
            expect(tauriConfig.version).toBe('1.2.3-nightly.20260522.42.1');
            expect(cargoToml).toContain('version = "1.2.3-nightly.20260522.42.1"');
            expect(cargoToml).toContain('tauri-codegen = "2.6"');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
