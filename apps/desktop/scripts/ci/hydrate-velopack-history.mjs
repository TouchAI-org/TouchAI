import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { channelFromTag, githubRepositoryFromProduct } from '../update-release-assets.mjs';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_USER_AGENT = 'touchai-velopack-history-hydrate/1.0.0';
const HISTORY_FETCH_TIMEOUT_MS = 30_000;
const MAX_RELEASE_PAGES = 10;

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
    assertNonEmptyString(product?.repository?.url, 'repository.url');
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

function githubHeaders(token) {
    const headers = new Headers({
        accept: 'application/vnd.github+json',
        'user-agent': GITHUB_USER_AGENT,
        'x-github-api-version': '2022-11-28',
    });
    if (token) {
        headers.set('authorization', `Bearer ${token}`);
    }
    return headers;
}

async function fetchGithubReleases(repository, fetchImpl, token) {
    const releases = [];
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
        const response = await fetchImpl(
            `${GITHUB_API_BASE_URL}/repos/${repository}/releases?per_page=100&page=${page}`,
            { headers: githubHeaders(token) }
        );
        if (!response.ok) {
            throw new Error(`Failed to fetch GitHub releases: HTTP ${response.status}`);
        }

        const pageReleases = await response.json();
        if (!Array.isArray(pageReleases)) {
            throw new Error('GitHub releases response must be an array.');
        }

        releases.push(...pageReleases);
        if (pageReleases.length < 100) {
            break;
        }
    }
    return releases;
}

function retentionForChannel(product, channel) {
    const retentionByChannel = product.services?.updates?.deployment?.r2HotAssetVersions ?? {};
    if (!Object.hasOwn(retentionByChannel, channel)) {
        const expected = Object.keys(retentionByChannel).sort().join(', ');
        throw new Error(`Unsupported release channel "${channel}". Expected one of: ${expected}.`);
    }

    const value = retentionByChannel[channel];
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function releaseTime(release) {
    const value = release.published_at ?? release.created_at ?? '';
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : 0;
}

function retainedReleaseTags(releases, channel, keepVersions) {
    return new Set(
        releases
            .filter((release) => channelFromTag(release?.tag_name) === channel)
            .sort((left, right) => releaseTime(right) - releaseTime(left))
            .slice(0, keepVersions)
            .map((release) => release.tag_name)
            .filter(Boolean)
    );
}

function releaseTagFromFeedAsset(asset) {
    if (typeof asset?.Version === 'string' && asset.Version.trim()) {
        return `v${asset.Version}`;
    }
    return null;
}

async function retainedHistoryTags(product, channel) {
    const keepVersions = retentionForChannel(product, channel);
    if (keepVersions <= 0) {
        return new Set();
    }

    const repository = githubRepositoryFromProduct(product, {
        invalidHostMessage: 'repository.url must use github.com for Velopack history hydration.',
    });
    const releases = await fetchGithubReleases(
        repository,
        globalThis.fetch,
        process.env.GITHUB_TOKEN ?? null
    );
    return retainedReleaseTags(releases, channel, keepVersions);
}

function pruneFeedAssets(feed, retainedTags) {
    if (!Array.isArray(feed.Assets)) {
        return feed;
    }

    return {
        ...feed,
        Assets: feed.Assets.filter((asset) => retainedTags.has(releaseTagFromFeedAsset(asset))),
    };
}

function updateAssetUrl(product, fileName) {
    return `${product.services.updates.baseUrl.replace(/\/+$/g, '')}/${encodeURIComponent(fileName)}`;
}

function isVelopackPackage(asset) {
    return (
        asset &&
        typeof asset.FileName === 'string' &&
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
    const feed = pruneFeedAssets(JSON.parse(feedText), await retainedHistoryTags(product, channel));
    await writeFile(join(releaseDir, feedName), `${JSON.stringify(feed, null, 4)}\n`, 'utf8');

    const assets = Array.isArray(feed.Assets) ? feed.Assets.filter(isVelopackPackage) : [];
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
