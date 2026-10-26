import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const lockfilePath = join(process.cwd(), '..', '..', 'pnpm-lock.yaml');

/**
 * A root-level pnpm override can silently pull a patched direct dependency back
 * below its advisory floor. That is how dompurify stayed on 3.4.16 while the app
 * already asked for 3.4.17.
 *
 * Each value is the first patched release from the advisory, so the guard fails
 * on the vulnerable version and on anything older, not only on today's exact pin.
 */
const patchedFloors: Record<string, string> = {
    dompurify: '3.4.17',
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
