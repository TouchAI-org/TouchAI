import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeReleaseChecksums } from '../../scripts/ci/release-checksums.mjs';
import { stageReleaseUploadAssets } from '../../scripts/ci/stage-release-upload-assets.mjs';

const roots: string[] = [];
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-release-checksums-'));
    roots.push(root);
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('given a release directory containing historical packages', () => {
    it('user can verify only the final published version and its metadata with standard checksums', async () => {
        const root = await fixture();
        const input = join(root, 'input');
        const output = join(root, 'output');
        await mkdir(input);
        await writeFile(join(input, 'TouchAI-1.2.3-windows.msi'), 'abc');
        await writeFile(join(input, 'TouchAI-1.2.2-windows-full.nupkg'), 'old bytes');
        await stageReleaseUploadAssets(input, output, { version: '1.2.3' });
        await writeFile(join(output, 'release-notes.json'), '{"en-US":"Notes"}');
        await writeFile(join(output, 'TouchAI-1.2.3.source.spdx.json'), '{}');
        await writeReleaseChecksums(output);
        const checksums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
        expect(checksums).toContain(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  TouchAI-1.2.3-windows.msi\n'
        );
        expect(checksums).toContain('  release-notes.json\n');
        expect(checksums).toContain('  TouchAI-1.2.3.source.spdx.json\n');
        expect(checksums).not.toContain('1.2.2');

        await writeFile(join(output, 'provenance.sigstore.json'), 'signed bundle');
        await writeReleaseChecksums(output);
        expect(await readFile(join(output, 'SHA256SUMS'), 'utf8')).toBe(checksums);
        await writeFile(join(output, 'TouchAI-1.2.3-windows.msi'), 'changed bytes');
        await writeReleaseChecksums(output);
        expect(await readFile(join(output, 'SHA256SUMS'), 'utf8')).not.toBe(checksums);
    });

    it('user gets a clear failure instead of an empty integrity manifest', async () => {
        await expect(writeReleaseChecksums(await fixture())).rejects.toThrow(/No release assets/);
    });

    it('user cannot accidentally publish checksums for paths outside the staged release', async () => {
        const root = await fixture();
        await mkdir(join(root, 'stage'));
        await writeFile(join(root, 'outside'), 'private bytes');
        await symlink(join(root, 'outside'), join(root, 'stage/link'));
        await expect(writeReleaseChecksums(join(root, 'stage'))).rejects.toThrow(/regular file/);
        await expect(readFile(join(root, 'stage/SHA256SUMS'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });
});
