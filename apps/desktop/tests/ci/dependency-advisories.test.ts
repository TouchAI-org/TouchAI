import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import semver from 'semver';
import { describe, expect, it } from 'vitest';

const lockfilePath = join(process.cwd(), '..', '..', 'pnpm-lock.yaml');
const cargoLockfilePath = join(process.cwd(), 'src-tauri', 'Cargo.lock');

/**
 * A root-level pnpm override can silently pull a patched direct dependency back
 * below its advisory floor. That is how dompurify stayed on 3.4.16 while the app
 * already asked for 3.4.17.
 *
 * Each entry lists every range the advisories declare, not a single floor. A
 * higher major is not automatically safe: `@vitest/mocker` 5.0.0 and
 * `fast-uri` 4.0.0 are both inside an affected range, and a floor comparison
 * cannot read the prerelease boundary in `5.0.0-rc.2`.
 */
const affectedRanges: Record<string, string[]> = {
    '@vitest/mocker': ['>=2.1.0-beta.7 <4.1.12', '>=5.0.0-beta.1 <5.0.3'],
    dompurify: ['<=3.4.16'],
    esbuild: ['<=0.24.2'],
    'fast-uri': ['<2.4.8', '>=3.0.0 <3.1.9', '>=4.0.0 <4.2.3'],
    'serialize-javascript': ['<7.1.3'],
    zod: ['<4.6.6'],
};

const affectedRustRanges: Record<string, string[]> = {
    rustls: ['>=0.23.13 <0.23.45'],
    rand: ['>=0.7.0 <0.8.6', '>=0.9.0 <0.9.3', '=0.10.0'],
};

/**
 * Tauri's kuchikiki -> phf build chain still pins rand 0.7.x. It is a
 * build-only dependency and the advisory needs a custom logger that the build
 * script never installs, so that one version is allowlisted rather than fixed.
 */
const rustExceptions = new Set(['rand@0.7.3']);

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAffected(version: string, ranges: string[]): boolean {
    // `includePrerelease` matters: npm's default range check excludes every
    // prerelease, so `4.1.0-beta.1` would slip past `>=2.1.0-beta.7 <4.1.12`
    // even though it sits inside the affected line.
    return ranges.some((range) => semver.satisfies(version, range, { includePrerelease: true }));
}

async function readLockedVersions(packageName: string): Promise<string[]> {
    const lockfile = await readFile(lockfilePath, 'utf8');
    const pattern = new RegExp(`^  '?${escapeRegExp(packageName)}@([^'\\s(:]+)'?:$`, 'gm');

    return Array.from(new Set(Array.from(lockfile.matchAll(pattern), (match) => match[1]!)));
}

async function readCargoLockedVersions(packageName: string): Promise<string[]> {
    const lockfile = await readFile(cargoLockfilePath, 'utf8');
    const pattern = new RegExp(
        `\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = "([^"]+)"`,
        'g'
    );

    return Array.from(new Set(Array.from(lockfile.matchAll(pattern), (match) => match[1]!)));
}

describe('user installs the desktop app without a lockfile inside a vulnerable range', () => {
    for (const [packageName, ranges] of Object.entries(affectedRanges)) {
        it(`user gets no affected ${packageName} release`, async () => {
            const versions = await readLockedVersions(packageName);

            expect(versions, `${packageName} must be resolved in pnpm-lock.yaml`).not.toHaveLength(
                0
            );

            for (const version of versions) {
                expect(
                    isAffected(version, ranges),
                    `${packageName}@${version} is inside ${ranges.join(' or ')}`
                ).toBe(false);
            }
        });
    }
});

describe('user installs the native shell without a susceptible Rust dependency', () => {
    for (const [packageName, ranges] of Object.entries(affectedRustRanges)) {
        it(`user gets no affected ${packageName} release`, async () => {
            const versions = await readCargoLockedVersions(packageName);

            expect(versions, `${packageName} must be resolved in Cargo.lock`).not.toHaveLength(0);

            for (const version of versions) {
                if (rustExceptions.has(`${packageName}@${version}`)) continue;

                expect(
                    isAffected(version, ranges),
                    `${packageName}@${version} is inside ${ranges.join(' or ')}`
                ).toBe(false);
            }
        });
    }
});

describe('user gets a guard that rejects every affected advisory branch', () => {
    const cases: Array<[string, string, boolean]> = [
        ['@vitest/mocker', '4.1.11', true],
        ['@vitest/mocker', '4.1.0-beta.1', true],
        ['@vitest/mocker', '4.1.12-beta.1', true],
        ['@vitest/mocker', '4.1.12', false],
        ['@vitest/mocker', '5.0.0', true],
        ['@vitest/mocker', '5.0.0-rc.2', true],
        ['@vitest/mocker', '5.0.3-beta.1', true],
        ['@vitest/mocker', '5.0.3', false],
        ['fast-uri', '2.4.7', true],
        ['fast-uri', '2.4.8-beta.1', true],
        ['fast-uri', '2.4.8', false],
        ['fast-uri', '3.1.8', true],
        ['fast-uri', '3.1.9', false],
        ['fast-uri', '4.0.0', true],
        ['fast-uri', '4.2.3', false],
        ['dompurify', '3.4.16', true],
        ['dompurify', '3.4.17', false],
        ['zod', '4.6.5', true],
        ['zod', '4.6.6', false],
    ];

    for (const [packageName, version, expected] of cases) {
        it(`user sees ${packageName}@${version} reported as ${expected ? 'affected' : 'safe'}`, () => {
            expect(isAffected(version, affectedRanges[packageName]!)).toBe(expected);
        });
    }

    const rustCases: Array<[string, string, boolean]> = [
        ['rustls', '0.23.44', true],
        ['rustls', '0.23.45', false],
        ['rand', '0.8.5', true],
        ['rand', '0.8.8', false],
        ['rand', '0.10.0', true],
        ['rand', '0.10.1', false],
    ];

    for (const [packageName, version, expected] of rustCases) {
        it(`user sees ${packageName}@${version} reported as ${expected ? 'affected' : 'safe'}`, () => {
            expect(isAffected(version, affectedRustRanges[packageName]!)).toBe(expected);
        });
    }
});

describe('user runs the E2E harness without the WebdriverIO 9 download chain', () => {
    for (const packageName of ['basic-ftp', 'extract-zip', 'ip-address']) {
        it(`user gets no ${packageName} in the lockfile`, async () => {
            expect(
                await readLockedVersions(packageName),
                `${packageName} must be gone after the WebdriverIO 10 migration`
            ).toHaveLength(0);
        });
    }
});
