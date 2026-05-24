import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { APP_PRODUCT_CONFIG } from '@/config/product';

async function loadValidator(): Promise<
    | ((
          projectRoot: string,
          options?: { tagName?: string | null; expectedIdentifier?: string; skipTag?: boolean }
      ) => Promise<string[]>)
    | undefined
> {
    try {
        const module = await import('../../scripts/ci/version-policy-check.mjs');
        return module.validateVersionPolicy as (
            projectRoot: string,
            options?: { tagName?: string | null; expectedIdentifier?: string; skipTag?: boolean }
        ) => Promise<string[]>;
    } catch {
        return undefined;
    }
}

async function createFixture(files: {
    packageVersion: string;
    cargoVersion: string;
    tauriVersion: string;
    identifier?: string;
}) {
    const root = await mkdtemp(join(tmpdir(), 'touchai-version-policy-'));
    const tauriRoot = join(root, 'src-tauri');
    await mkdir(tauriRoot, { recursive: true });
    await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ version: files.packageVersion }, null, 2)
    );
    await writeFile(
        join(root, 'product.json'),
        JSON.stringify({ identifier: APP_PRODUCT_CONFIG.identifier }, null, 2)
    );
    await writeFile(
        join(tauriRoot, 'Cargo.toml'),
        `[package]\nname = "touchai"\nversion = "${files.cargoVersion}"\n`
    );
    await writeFile(
        join(tauriRoot, 'tauri.conf.json'),
        JSON.stringify(
            {
                version: files.tauriVersion,
                identifier: files.identifier ?? APP_PRODUCT_CONFIG.identifier,
            },
            null,
            2
        )
    );
    return root;
}

describe('validateVersionPolicy', () => {
    it('accepts matching app versions, identifier, and release tag', async () => {
        const validateVersionPolicy = await loadValidator();
        const root = await createFixture({
            packageVersion: '0.2.0',
            cargoVersion: '0.2.0',
            tauriVersion: '0.2.0',
        });

        try {
            expect(validateVersionPolicy).toBeTypeOf('function');
            await expect(validateVersionPolicy?.(root, { tagName: 'v0.2.0' })).resolves.toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reports mismatched versions and identifier', async () => {
        const validateVersionPolicy = await loadValidator();
        const root = await createFixture({
            packageVersion: '0.2.0',
            cargoVersion: '0.2.1',
            tauriVersion: '0.2.0',
            identifier: 'com.qiancheng.touchai',
        });

        try {
            expect(validateVersionPolicy).toBeTypeOf('function');
            await expect(validateVersionPolicy?.(root, { tagName: 'v0.2.0' })).resolves.toEqual([
                'src-tauri/Cargo.toml version 0.2.1 does not match package.json version 0.2.0.',
                `src-tauri/tauri.conf.json identifier com.qiancheng.touchai does not match ${APP_PRODUCT_CONFIG.identifier}.`,
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reports release tags that do not match the app version', async () => {
        const validateVersionPolicy = await loadValidator();
        const root = await createFixture({
            packageVersion: '0.2.0',
            cargoVersion: '0.2.0',
            tauriVersion: '0.2.0',
        });

        try {
            expect(validateVersionPolicy).toBeTypeOf('function');
            await expect(validateVersionPolicy?.(root, { tagName: 'v0.3.0' })).resolves.toEqual([
                'Release tag v0.3.0 does not match expected tag v0.2.0.',
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('can skip release tag validation before the CI workspace version is rewritten', async () => {
        const validateVersionPolicy = await loadValidator();
        const root = await createFixture({
            packageVersion: '0.2.0',
            cargoVersion: '0.2.0',
            tauriVersion: '0.2.0',
        });

        try {
            expect(validateVersionPolicy).toBeTypeOf('function');
            await expect(
                validateVersionPolicy?.(root, { tagName: 'v0.3.0', skipTag: true })
            ).resolves.toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
