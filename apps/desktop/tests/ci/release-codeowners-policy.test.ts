import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../../..');

async function readCodeowners() {
    return readFile(resolve(repositoryRoot, '.github/CODEOWNERS'), 'utf8');
}

function codeownerPatterns(codeowners: string) {
    return codeowners
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => line.split(/\s+/)[0] ?? '');
}

function patternMatchesPath(pattern: string, path: string) {
    const normalizedPattern = pattern.replace(/^\//, '');

    if (normalizedPattern.endsWith('/')) {
        return path.startsWith(normalizedPattern);
    }

    return path === normalizedPattern;
}

function ownedByCodeowners(codeowners: string, path: string) {
    return codeownerPatterns(codeowners).some((pattern) => patternMatchesPath(pattern, path));
}

describe('release CODEOWNERS policy', () => {
    it('leaves Release Please generated version files outside the code owner gate', async () => {
        const codeowners = await readCodeowners();

        const generatedReleaseFiles = [
            '.release-please-manifest.json',
            'apps/desktop/CHANGELOG.md',
            'apps/desktop/package.json',
            'apps/desktop/src-tauri/Cargo.toml',
            'apps/desktop/src-tauri/tauri.conf.json',
        ];

        expect(generatedReleaseFiles.filter((path) => ownedByCodeowners(codeowners, path))).toEqual(
            []
        );
    });

    it('keeps release automation controls under maintainer review', async () => {
        const codeowners = await readCodeowners();

        expect(ownedByCodeowners(codeowners, 'release-please-config.json')).toBe(true);
        expect(ownedByCodeowners(codeowners, '.github/workflows/release-please.yml')).toBe(true);
        expect(
            ownedByCodeowners(codeowners, 'apps/desktop/scripts/ci/resolve-release-metadata.mjs')
        ).toBe(true);
    });
});
