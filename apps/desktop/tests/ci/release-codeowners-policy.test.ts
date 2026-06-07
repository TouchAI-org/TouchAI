import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../../..');

async function readCodeowners() {
    return readFile(resolve(repositoryRoot, '.github/CODEOWNERS'), 'utf8');
}

function codeownerEntries(codeowners: string) {
    return codeowners
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => {
            const [pattern = '', ...owners] = line.split(/\s+/);

            return { pattern, owners };
        });
}

function patternMatchesPath(pattern: string, path: string) {
    const normalizedPattern = pattern.replace(/^\//, '');

    if (normalizedPattern.endsWith('/')) {
        return path.startsWith(normalizedPattern);
    }

    return path === normalizedPattern;
}

function ownersForPath(codeowners: string, path: string) {
    const matches = codeownerEntries(codeowners).filter(({ pattern }) =>
        patternMatchesPath(pattern, path)
    );
    const lastMatch = matches[matches.length - 1];

    return lastMatch?.owners ?? [];
}

function ownedByCodeowners(codeowners: string, path: string) {
    return ownersForPath(codeowners, path).length > 0;
}

function ownedByMaintainer(codeowners: string, path: string) {
    return ownersForPath(codeowners, path).includes('@hiqiancheng');
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

        expect(ownedByMaintainer(codeowners, 'release-please-config.json')).toBe(true);
        expect(ownedByMaintainer(codeowners, '.github/workflows/release-please.yml')).toBe(true);
        expect(
            ownedByMaintainer(codeowners, 'apps/desktop/scripts/ci/resolve-release-metadata.mjs')
        ).toBe(true);
    });
});
