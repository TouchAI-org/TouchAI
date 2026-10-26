import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const lockfilePath = join(process.cwd(), '..', '..', 'pnpm-lock.yaml');
const cargoLockfilePath = join(process.cwd(), 'src-tauri', 'Cargo.lock');

/**
 * A root-level pnpm override can silently pull a patched direct dependency back
 * below its advisory floor. That is how dompurify stayed on 3.4.16 while the app
 * already asked for 3.4.17.
 *
 * Each value is the first patched release from the advisory, so the guard fails
 * on the vulnerable version and on anything older, not only on today's exact pin.
 */
const patchedFloors: Record<string, string> = {
    '@vitest/mocker': '4.1.12',
    dompurify: '3.4.17',
    esbuild: '0.25.0',
    'fast-uri': '3.1.9',
    'serialize-javascript': '7.1.3',
    zod: '4.6.6',
};

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);

    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
        const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
        if (difference !== 0) return difference;
    }

    return 0;
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

describe('user installs the desktop app without a lockfile pinned below a patched advisory', () => {
    for (const [packageName, floor] of Object.entries(patchedFloors)) {
        it(`user gets ${packageName} at or above ${floor}`, async () => {
            const versions = await readLockedVersions(packageName);

            expect(versions, `${packageName} must be resolved in pnpm-lock.yaml`).not.toHaveLength(
                0
            );

            for (const version of versions) {
                expect(
                    compareVersions(version, floor),
                    `${packageName}@${version} is below the patched floor ${floor}`
                ).toBeGreaterThanOrEqual(0);
            }
        });
    }
});

describe('user installs the native shell without a susceptible Rust dependency', () => {
    it('user gets rustls at or above 0.23.45', async () => {
        const versions = await readCargoLockedVersions('rustls');

        expect(versions, 'rustls must be resolved in Cargo.lock').not.toHaveLength(0);

        for (const version of versions) {
            expect(
                compareVersions(version, '0.23.45'),
                `rustls@${version} is below the patched floor 0.23.45`
            ).toBeGreaterThanOrEqual(0);
        }
    });

    it('user gets rand patched on every runtime line', async () => {
        const versions = await readCargoLockedVersions('rand');

        expect(versions, 'rand must be resolved in Cargo.lock').not.toHaveLength(0);

        for (const version of versions) {
            // Tauri's kuchikiki -> phf build chain still pins rand 0.7.x. It is a
            // build-only dependency and the advisory needs a custom logger that the
            // build script never installs.
            if (version.startsWith('0.7.')) continue;

            const inAffectedRange =
                (compareVersions(version, '0.8.0') >= 0 && compareVersions(version, '0.8.6') < 0) ||
                (compareVersions(version, '0.9.0') >= 0 && compareVersions(version, '0.9.3') < 0) ||
                compareVersions(version, '0.10.0') === 0;

            expect(inAffectedRange, `rand@${version} is inside GHSA-cq8v-f236-94qc`).toBe(false);
        }
    });
});
