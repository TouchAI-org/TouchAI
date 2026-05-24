import { readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
}

function publicNameSegment(value, label) {
    assertNonEmptyString(value, label);

    const segment = value.trim().replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!segment) {
        throw new Error(`${label} must contain at least one file-name safe character.`);
    }

    return segment;
}

async function readProduct(projectRoot) {
    const product = JSON.parse(await readFile(join(projectRoot, 'product.json'), 'utf8'));
    assertNonEmptyString(product.displayName, 'product.json displayName');
    assertNonEmptyString(product.identifier, 'product.json identifier');
    return product;
}

function publicArtifactPrefix(product, channel) {
    const productName = publicNameSegment(product.displayName, 'product.json displayName');
    if (channel === 'stable') {
        return productName;
    }

    return `${productName}-${publicNameSegment(channel, 'release channel')}`;
}

function publicArtifactName(fileName, product, options) {
    const { channel, version } = options;
    const prefix = publicArtifactPrefix(product, channel);
    const lowerName = fileName.toLowerCase();
    const hasTargetVersion = fileName.includes(version);

    if (lowerName.endsWith('-full.nupkg') && hasTargetVersion) {
        return `${prefix}-${version}-full.nupkg`;
    }

    if (lowerName.endsWith('-delta.nupkg') && hasTargetVersion) {
        return `${prefix}-${version}-delta.nupkg`;
    }

    if (lowerName.endsWith('-setup.exe')) {
        return `${prefix}-${version}-Setup.exe`;
    }

    if (lowerName.endsWith('-portable.zip')) {
        return `${prefix}-${version}-Portable.zip`;
    }

    return null;
}

async function fileExists(path) {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function rewriteJsonStrings(value, renameMap) {
    if (typeof value === 'string') {
        return renameMap.get(value) ?? value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => rewriteJsonStrings(item, renameMap));
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, rewriteJsonStrings(item, renameMap)])
        );
    }

    return value;
}

function replaceAllFileNames(text, renameMap) {
    let next = text;
    for (const [from, to] of renameMap) {
        next = next.split(from).join(to);
    }
    return next;
}

async function rewriteReleaseIndexes(releaseDir, renameMap) {
    const entries = await readdir(releaseDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const path = join(releaseDir, entry.name);
        if (entry.name.endsWith('.json')) {
            const text = await readFile(path, 'utf8');
            const rewritten = rewriteJsonStrings(JSON.parse(text), renameMap);
            await writeFile(path, `${JSON.stringify(rewritten, null, 4)}\n`, 'utf8');
            continue;
        }

        if (entry.name.startsWith('RELEASES')) {
            const text = await readFile(path, 'utf8');
            await writeFile(path, replaceAllFileNames(text, renameMap), 'utf8');
        }
    }
}

export async function normalizeVelopackReleaseAssets(projectRoot, releaseDir, options) {
    assertNonEmptyString(releaseDir, 'release directory');
    assertNonEmptyString(options?.channel, 'release channel');
    assertNonEmptyString(options?.version, 'release version');

    const product = await readProduct(projectRoot);
    const entries = await readdir(releaseDir, { withFileTypes: true });
    const renameMap = new Map();

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const nextName = publicArtifactName(entry.name, product, options);
        if (!nextName || nextName === entry.name) {
            continue;
        }

        if (renameMap.has(entry.name)) {
            throw new Error(`Duplicate release asset rename source: ${entry.name}`);
        }

        if ([...renameMap.values()].includes(nextName)) {
            throw new Error(`Duplicate release asset rename target: ${nextName}`);
        }

        renameMap.set(entry.name, nextName);
    }

    for (const [from, to] of renameMap) {
        const fromPath = join(releaseDir, from);
        const toPath = join(releaseDir, to);
        if (await fileExists(toPath)) {
            throw new Error(`Cannot rename ${from} to ${to} because the target already exists.`);
        }
        await rename(fromPath, toPath);
    }

    await rewriteReleaseIndexes(releaseDir, renameMap);
}

function parseArgs(argv) {
    const [releaseDir, channel, version] = argv;
    if (!releaseDir || !channel || !version) {
        throw new Error(
            'Usage: node scripts/ci/normalize-velopack-release-assets.mjs <release-dir> <channel> <version>'
        );
    }

    return { releaseDir, channel, version };
}

async function main() {
    const { releaseDir, channel, version } = parseArgs(process.argv.slice(2));
    await normalizeVelopackReleaseAssets(process.cwd(), releaseDir, { channel, version });
    console.log(`Velopack release asset names normalized for ${channel} ${version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
