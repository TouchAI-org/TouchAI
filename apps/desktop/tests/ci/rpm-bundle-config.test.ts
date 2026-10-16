import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

type RpmBundleConfig = (version: string) => {
    version: string;
    bundle?: { linux: { rpm: { release: string } } };
};

async function loadRpmBundleConfig(): Promise<RpmBundleConfig | undefined> {
    try {
        const module = await import('../../scripts/ci/rpm-bundle-config.mjs');
        return module.rpmBundleConfig as RpmBundleConfig;
    } catch {
        return undefined;
    }
}

async function requireRpmBundleConfig(): Promise<RpmBundleConfig> {
    const rpmBundleConfig = await loadRpmBundleConfig();
    expect(rpmBundleConfig).toBeTypeOf('function');
    return rpmBundleConfig as RpmBundleConfig;
}

describe('rpmBundleConfig', () => {
    it('moves the SemVer prerelease into the RPM release field', async () => {
        const rpmBundleConfig = await requireRpmBundleConfig();

        expect(rpmBundleConfig('1.2.3-beta.1')).toEqual({
            version: '1.2.3',
            bundle: { linux: { rpm: { release: '0.beta.1' } } },
        });
        expect(rpmBundleConfig('1.2.3-nightly.20261016.180.1')).toEqual({
            version: '1.2.3',
            bundle: { linux: { rpm: { release: '0.nightly.20261016.180.1' } } },
        });
    });

    it('leaves stable versions on the default RPM release', async () => {
        const rpmBundleConfig = await requireRpmBundleConfig();

        expect(rpmBundleConfig('1.2.3')).toEqual({ version: '1.2.3' });
    });

    it('keeps the RPM version and release fields free of hyphens', async () => {
        const rpmBundleConfig = await requireRpmBundleConfig();

        expect(rpmBundleConfig('1.2.3-beta.1+build.7')).toEqual({
            version: '1.2.3',
            bundle: { linux: { rpm: { release: '0.beta.1' } } },
        });
        expect(rpmBundleConfig('1.2.3-beta-1')).toEqual({
            version: '1.2.3',
            bundle: { linux: { rpm: { release: '0.beta~1' } } },
        });
    });

    it('rejects versions that are not valid semantic versions', async () => {
        const rpmBundleConfig = await requireRpmBundleConfig();

        expect(() => rpmBundleConfig('not-a-version')).toThrow();
        expect(() => rpmBundleConfig('')).toThrow();
    });

    it('prints a JSON config the Tauri CLI can consume', () => {
        const output = execFileSync(
            process.execPath,
            ['scripts/ci/rpm-bundle-config.mjs', '1.2.3-beta.1'],
            { encoding: 'utf8' }
        );

        expect(JSON.parse(output)).toEqual({
            version: '1.2.3',
            bundle: { linux: { rpm: { release: '0.beta.1' } } },
        });
    });
});
