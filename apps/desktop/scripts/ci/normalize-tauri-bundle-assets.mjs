import { readdir, rename, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
}

function publicNameSegment(value, label) {
    assertNonEmptyString(value, label);

    const segment = value
        .trim()
        .replace(/[^0-9A-Za-z._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
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

function platformArtifactPrefix(product, channel, version, platform) {
    return `${publicArtifactPrefix(product, channel)}-${version}-${platform}`;
}

function publicArtifactName(fileName, product, options) {
    const { channel, version } = options;
    const lowerName = fileName.toLowerCase();
    const macosPrefix = platformArtifactPrefix(product, channel, version, 'macos');
    const linuxPrefix = platformArtifactPrefix(product, channel, version, 'linux');

    if (lowerName.endsWith('.dmg')) {
        return `${macosPrefix}.dmg`;
    }

    if (lowerName.endsWith('.app.tar.gz')) {
        return `${macosPrefix}.app.tar.gz`;
    }

    if (lowerName.endsWith('.appimage')) {
        return `${linuxPrefix}.AppImage`;
    }

    if (lowerName.endsWith('.appimage.tar.gz')) {
        return `${linuxPrefix}.AppImage.tar.gz`;
    }

    if (lowerName.endsWith('.deb')) {
        return `${linuxPrefix}-amd64.deb`;
    }

    if (lowerName.endsWith('.rpm')) {
        return `${linuxPrefix}-x86_64.rpm`;
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

export async function normalizeTauriBundleAssets(projectRoot, releaseDir, options) {
    assertNonEmptyString(releaseDir, 'release directory');
    assertNonEmptyString(options?.channel, 'release channel');
    assertNonEmptyString(options?.version, 'release version');

    const product = await readProduct(projectRoot);
    const entries = await readdir(releaseDir, { withFileTypes: true });

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const nextName = publicArtifactName(entry.name, product, options);
        if (!nextName || nextName === entry.name) {
            continue;
        }

        const fromPath = join(releaseDir, entry.name);
        const toPath = join(releaseDir, nextName);
        if (await fileExists(toPath)) {
            throw new Error(`Cannot rename ${entry.name} to ${nextName} because the target already exists.`);
        }

        await rename(fromPath, toPath);
    }
}

function parseArgs(argv) {
    const [releaseDir, channel, version] = argv;
    if (!releaseDir || !channel || !version) {
        throw new Error(
            'Usage: node scripts/ci/normalize-tauri-bundle-assets.mjs <release-dir> <channel> <version>'
        );
    }

    return { releaseDir, channel, version };
}

async function main() {
    const { releaseDir, channel, version } = parseArgs(process.argv.slice(2));
    await normalizeTauriBundleAssets(process.cwd(), releaseDir, { channel, version });
    console.log(`Tauri bundle asset names normalized for ${channel} ${version}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
