import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeLocalizedReleaseNotes } from './release-notes.mjs';

const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

async function releaseNoteFilenames(directory) {
    let entries;
    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error(`Release notes directory not found: ${directory}`, { cause: error });
        }
        throw error;
    }

    const filenames = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort();

    if (filenames.length === 0) {
        throw new Error(`No release note JSON files found in ${directory}.`);
    }

    return filenames;
}

export async function validateReleaseNotesDirectory(directory) {
    const filenames = await releaseNoteFilenames(directory);

    for (const filename of filenames) {
        const version = filename.slice(0, -'.json'.length);
        if (!SEMVER_PATTERN.test(version)) {
            throw new Error(
                `Release notes file ${filename} must be named after a semantic version.`
            );
        }

        let value;
        try {
            value = JSON.parse(await readFile(join(directory, filename), 'utf8'));
        } catch (error) {
            throw new Error(`Release notes file ${filename} is not valid JSON: ${error.message}`, {
                cause: error,
            });
        }

        let notes;
        try {
            notes = normalizeLocalizedReleaseNotes(value);
        } catch (error) {
            throw new Error(`Release notes file ${filename} is invalid: ${error.message}`, {
                cause: error,
            });
        }

        const english = notes['en-US'] ?? notes.en;
        if (!english || !notes['zh-CN']) {
            throw new Error(
                `Release notes file ${filename} must include reviewed en-US and zh-CN content.`
            );
        }
    }

    return filenames;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const directory =
        process.argv[2] ?? fileURLToPath(new URL('../../release-notes', import.meta.url));

    validateReleaseNotesDirectory(directory)
        .then((filenames) => {
            console.log(
                `Validated ${filenames.length} release note file(s): ${filenames.join(', ')}`
            );
        })
        .catch((error) => {
            console.error(error.message ?? error);
            process.exitCode = 1;
        });
}
