import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    assertNonEmptyString,
    isDownloadAssetName,
    versionFromAssetName,
} from '../update-release-assets.mjs';

function currentReleaseAssetName(fileName, version) {
    return isDownloadAssetName(fileName) && versionFromAssetName(fileName) === version;
}

export async function stageReleaseUploadAssets(releaseDir, outputDir, options) {
    assertNonEmptyString(releaseDir, 'release directory');
    assertNonEmptyString(outputDir, 'output directory');
    assertNonEmptyString(options?.version, 'release version');

    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });

    const entries = await readdir(releaseDir, { withFileTypes: true });
    const stagedNames = [];
    for (const entry of entries) {
        if (!entry.isFile() || !currentReleaseAssetName(entry.name, options.version)) {
            continue;
        }

        await copyFile(join(releaseDir, entry.name), join(outputDir, entry.name));
        stagedNames.push(entry.name);
    }

    stagedNames.sort((left, right) => left.localeCompare(right));
    if (stagedNames.length === 0) {
        throw new Error(`No current-version release assets found for ${options.version}.`);
    }

    return stagedNames;
}

function parseArgs(argv) {
    const [releaseDir, outputDir, version] = argv;
    if (!releaseDir || !outputDir || !version) {
        throw new Error(
            'Usage: node scripts/ci/stage-release-upload-assets.mjs <release-dir> <output-dir> <version>'
        );
    }

    return { releaseDir, outputDir, version };
}

async function main() {
    const { releaseDir, outputDir, version } = parseArgs(process.argv.slice(2));
    const stagedNames = await stageReleaseUploadAssets(releaseDir, outputDir, { version });
    console.log(`Staged ${stagedNames.length} current-version release asset(s) for ${version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
