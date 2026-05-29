import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    assertNonEmptyString,
    channelFromAssetName,
    channelFromTag,
    githubRepositoryFromProduct,
    isDownloadAssetName,
    relativeUpdatePath,
} from '../update-release-assets.mjs';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_USER_AGENT = 'touchai-r2-release-asset-prune/1.0.0';
const MAX_RELEASE_PAGES = 10;

async function readProduct(projectRoot) {
    const product = JSON.parse(await readFile(join(projectRoot, 'product.json'), 'utf8'));
    assertNonEmptyString(product?.repository?.url, 'repository.url');
    assertNonEmptyString(product?.services?.updates?.baseUrl, 'services.updates.baseUrl');
    return product;
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

export async function planR2ReleaseAssetPrune(projectRoot, channel, options = {}) {
    assertNonEmptyString(channel, 'release channel');

    const product = await readProduct(projectRoot);
    const keepVersions = retentionForChannel(product, channel);
    if (keepVersions <= 0) {
        return [];
    }

    const repository = githubRepositoryFromProduct(product, {
        invalidHostMessage: 'repository.url must use github.com for R2 release asset pruning.',
    });
    const updatePath = relativeUpdatePath(product.services.updates.baseUrl);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('fetch is required to plan R2 release asset pruning.');
    }

    const releases = await fetchGithubReleases(repository, fetchImpl, options.token ?? null);
    const channelReleases = releases
        .filter((release) => channelFromTag(release?.tag_name) === channel)
        .sort((left, right) => releaseTime(right) - releaseTime(left));
    const staleReleases = channelReleases.slice(keepVersions);
    const keys = [];

    for (const release of staleReleases) {
        for (const asset of release.assets ?? []) {
            const fileName = asset?.name;
            if (!isDownloadAssetName(fileName) || channelFromAssetName(fileName) !== channel) {
                continue;
            }
            keys.push(`${updatePath}/${fileName}`);
        }
    }

    return [...new Set(keys)];
}

function parseArgs(argv) {
    const [channel] = argv;
    if (!channel) {
        throw new Error('Usage: node scripts/ci/plan-r2-release-asset-prune.mjs <channel>');
    }
    return { channel };
}

async function main() {
    const { channel } = parseArgs(process.argv.slice(2));
    const keys = await planR2ReleaseAssetPrune(process.cwd(), channel, {
        token: process.env.GITHUB_TOKEN ?? null,
    });
    if (keys.length > 0) {
        process.stdout.write(`${keys.join('\n')}\n`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
