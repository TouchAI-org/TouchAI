import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateReleaseNotesDirectory } from '../../scripts/ci/validate-release-notes.mjs';

const roots: string[] = [];

async function releaseNotesDirectory() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-release-notes-validation-'));
    roots.push(root);
    const directory = join(root, 'release-notes');
    await mkdir(directory);
    return directory;
}

async function writeNotes(
    directory: string,
    filename: string,
    content: Record<string, unknown> | string
) {
    await writeFile(
        join(directory, filename),
        typeof content === 'string' ? content : JSON.stringify(content)
    );
}

const reviewedNotes = {
    'en-US': '## New Features\n\n1. **Safer updates**: downloads can resume (#776)',
    'zh-CN': '## 新功能\n\n1. **更安全的更新**：下载可以继续（#776）',
};

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('given a directory of release note files', () => {
    it('user publishes a release when every file has a semantic version and both reviewed languages', async () => {
        const directory = await releaseNotesDirectory();
        await writeNotes(directory, '1.3.0-beta.3.json', reviewedNotes);

        await expect(validateReleaseNotesDirectory(directory)).resolves.toEqual([
            '1.3.0-beta.3.json',
        ]);
    });

    it('user gets a clear error when Chinese release notes are missing', async () => {
        const directory = await releaseNotesDirectory();
        await writeNotes(directory, '1.3.0-beta.3.json', {
            'en-US': reviewedNotes['en-US'],
        });

        await expect(validateReleaseNotesDirectory(directory)).rejects.toThrow(/zh-CN/);
    });

    it('user gets a clear error when a release note filename is not a semantic version', async () => {
        const directory = await releaseNotesDirectory();
        await writeNotes(directory, 'latest.json', reviewedNotes);

        await expect(validateReleaseNotesDirectory(directory)).rejects.toThrow(/semantic version/);
    });

    it('user gets a clear error when a release note file is not valid JSON', async () => {
        const directory = await releaseNotesDirectory();
        await writeNotes(directory, '1.3.0-beta.3.json', '{"en-US":');

        await expect(validateReleaseNotesDirectory(directory)).rejects.toThrow(
            /1\.3\.0-beta\.3\.json/
        );
    });
});
