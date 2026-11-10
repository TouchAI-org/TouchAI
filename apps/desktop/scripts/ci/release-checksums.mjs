import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_NAME = 'SHA256SUMS';
const PROVENANCE_NAME = 'provenance.sigstore.json';

export async function writeReleaseChecksums(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => ![MANIFEST_NAME, PROVENANCE_NAME].includes(entry.name))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    if (entries.length === 0) {
        throw new Error('No release assets to checksum.');
    }

    const lines = [];
    for (const entry of entries) {
        if (!entry.isFile() || /[\r\n\\]/u.test(entry.name)) {
            throw new Error(`Release asset must be a regular file with a safe name: ${entry.name}`);
        }
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(join(directory, entry.name))) {
            hash.update(chunk);
        }
        lines.push(`${hash.digest('hex')}  ${entry.name}`);
    }
    await writeFile(join(directory, MANIFEST_NAME), `${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    writeReleaseChecksums(process.argv[2]).catch((error) => {
        console.error(error.message ?? error);
        process.exitCode = 1;
    });
}
