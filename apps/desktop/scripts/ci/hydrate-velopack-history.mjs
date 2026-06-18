import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HISTORY_FETCH_TIMEOUT_MS = 30_000;

function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
}

function assertAbsoluteHttpsUrl(value, label) {
    assertNonEmptyString(value, label);
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${label} must be an absolute URL.`);
    }
    if (url.protocol !== 'https:') {
        throw new Error(`${label} must use https.`);
    }
}

async function readProduct(projectRoot) {
    const product = JSON.parse(await readFile(join(projectRoot, 'product.json'), 'utf8'));
    assertAbsoluteHttpsUrl(product?.services?.updates?.baseUrl, 'services.updates.baseUrl');
    return product;
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

async function fetchPublicAsset(url) {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(HISTORY_FETCH_TIMEOUT_MS),
    });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
    }
    return response;
}

function updateAssetUrl(product, fileName) {
    return `${product.services.updates.baseUrl.replace(/\/+$/g, '')}/${encodeURIComponent(fileName)}`;
}

function isSafeAssetFileName(fileName) {
    return (
        typeof fileName === 'string' &&
        fileName.trim() === fileName &&
        fileName.length > 0 &&
        !/[\\/]/u.test(fileName) &&
        fileName !== '.' &&
        fileName !== '..'
    );
}

function isVelopackPackage(asset) {
    return (
        asset &&
        typeof asset.FileName === 'string' &&
        isSafeAssetFileName(asset.FileName) &&
        asset.FileName.toLowerCase().endsWith('.nupkg')
    );
}

export async function hydrateVelopackHistory(projectRoot, releaseDir, channel) {
    assertNonEmptyString(releaseDir, 'release directory');
    assertNonEmptyString(channel, 'release channel');

    const product = await readProduct(projectRoot);
    await mkdir(releaseDir, { recursive: true });

    const feedName = `releases.${channel}.json`;
    const feedUrl = updateAssetUrl(product, feedName);
    const feedResponse = await fetchPublicAsset(feedUrl);
    if (!feedResponse) {
        console.log(`No existing ${channel} Velopack feed found at ${feedUrl}.`);
        return;
    }

    const feedText = await feedResponse.text();
    const feed = JSON.parse(feedText);
    const assets = Array.isArray(feed.Assets) ? feed.Assets.filter(isVelopackPackage) : [];
    const hydratedFeed = Array.isArray(feed.Assets) ? { ...feed, Assets: assets } : feed;
    await writeFile(
        join(releaseDir, feedName),
        `${JSON.stringify(hydratedFeed, null, 4)}\n`,
        'utf8'
    );

    for (const asset of assets) {
        const outputPath = join(releaseDir, asset.FileName);
        if (await fileExists(outputPath)) {
            continue;
        }

        const assetResponse = await fetchPublicAsset(updateAssetUrl(product, asset.FileName));
        if (!assetResponse) {
            continue;
        }

        const body = Buffer.from(await assetResponse.arrayBuffer());
        await writeFile(outputPath, body);
    }

    console.log(`Hydrated ${assets.length} existing ${channel} Velopack package entries.`);
}

function parseArgs(argv) {
    const [releaseDir, channel] = argv;
    if (!releaseDir || !channel) {
        throw new Error(
            'Usage: node scripts/ci/hydrate-velopack-history.mjs <release-dir> <channel>'
        );
    }
    return { releaseDir, channel };
}

async function main() {
    const { releaseDir, channel } = parseArgs(process.argv.slice(2));
    await hydrateVelopackHistory(process.cwd(), releaseDir, channel);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
