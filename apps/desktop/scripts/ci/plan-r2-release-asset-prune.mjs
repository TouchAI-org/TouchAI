import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    assertNonEmptyString,
    channelFromAssetName,
    channelFromTag,
    deriveReleaseTagFromAssetName,
    githubRepositoryFromProduct,
    isDownloadAssetName,
    relativeUpdatePath,
} from '../update-release-assets.mjs';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_USER_AGENT = 'touchai-r2-release-asset-prune/1.0.0';
const MAX_RELEASE_PAGES = 10;
const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const MAX_R2_OBJECT_PAGES = 100;

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

function cloudflareHeaders(token) {
    return new Headers({
        accept: 'application/json',
        authorization: `Bearer ${token}`,
    });
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

function cloudflareConfig(options) {
    const cloudflare = options.cloudflare ?? null;
    if (!cloudflare) {
        return null;
    }

    assertNonEmptyString(cloudflare.accountId, 'cloudflare.accountId');
    assertNonEmptyString(cloudflare.bucketName, 'cloudflare.bucketName');
    assertNonEmptyString(cloudflare.token, 'cloudflare.token');
    return {
        accountId: cloudflare.accountId,
        apiBaseUrl: cloudflare.apiBaseUrl ?? CLOUDFLARE_API_BASE_URL,
        bucketName: cloudflare.bucketName,
        token: cloudflare.token,
    };
}

function cloudflareConfigFromEnv(env) {
    const config = {
        accountId: env.CLOUDFLARE_ACCOUNT_ID,
        bucketName: env.CLOUDFLARE_R2_BUCKET_NAME,
        token: env.CLOUDFLARE_API_TOKEN,
    };
    const values = Object.values(config).filter((value) => typeof value === 'string' && value);
    if (values.length === 0) {
        return null;
    }
    if (values.length !== Object.keys(config).length) {
        throw new Error(
            'CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_R2_BUCKET_NAME must all be set to include existing R2 objects in the prune plan.'
        );
    }
    return config;
}

function r2ObjectsFromResponse(payload) {
    if (Array.isArray(payload?.result)) {
        return payload.result;
    }
    if (Array.isArray(payload?.result?.objects)) {
        return payload.result.objects;
    }
    if (Array.isArray(payload?.objects)) {
        return payload.objects;
    }
    throw new Error('Cloudflare R2 objects response must include an object array.');
}

function r2PaginationFromResponse(payload) {
    const info = payload?.result_info ?? payload?.result ?? payload ?? {};
    return {
        cursor: typeof info.cursor === 'string' ? info.cursor : null,
        truncated: Boolean(info.is_truncated ?? info.truncated ?? false),
    };
}

async function fetchR2ObjectKeys(config, updatePath, fetchImpl) {
    const keys = [];
    let cursor = null;

    for (let page = 1; page <= MAX_R2_OBJECT_PAGES; page += 1) {
        const params = new URLSearchParams({
            per_page: '1000',
            prefix: `${updatePath}/`,
        });
        if (cursor) {
            params.set('cursor', cursor);
        }

        const response = await fetchImpl(
            `${config.apiBaseUrl.replace(/\/+$/g, '')}/accounts/${encodeURIComponent(
                config.accountId
            )}/r2/buckets/${encodeURIComponent(config.bucketName)}/objects?${params}`,
            { headers: cloudflareHeaders(config.token) }
        );
        if (!response.ok) {
            throw new Error(`Failed to fetch Cloudflare R2 objects: HTTP ${response.status}`);
        }

        const payload = await response.json();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('Cloudflare R2 objects response must be an object.');
        }
        if (payload.success === false) {
            throw new Error('Cloudflare R2 objects response reported failure.');
        }

        for (const object of r2ObjectsFromResponse(payload)) {
            if (typeof object?.key === 'string') {
                keys.push(object.key);
            }
        }

        const pagination = r2PaginationFromResponse(payload);
        if (!pagination.truncated) {
            return keys;
        }
        if (!pagination.cursor) {
            throw new Error('Cloudflare R2 objects response is truncated but missing a cursor.');
        }
        cursor = pagination.cursor;
    }

    throw new Error(`Cloudflare R2 objects exceeded ${MAX_R2_OBJECT_PAGES} pages.`);
}

async function existingFeed(product, channel, fetchImpl) {
    const url = `${product.services.updates.baseUrl.replace(/\/+$/g, '')}/releases.${channel}.json`;
    const response = await fetchImpl(url);
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`Failed to fetch existing ${channel} update feed: HTTP ${response.status}`);
    }

    const feed = await response.json();
    if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
        throw new Error(`Existing ${channel} update feed must be an object.`);
    }
    return feed;
}

function staleReleaseAssetKeys(releases, keepVersions, updatePath, channel) {
    const channelReleases = releases
        .filter((release) => channelFromTag(release?.tag_name) === channel)
        .sort((left, right) => releaseTime(right) - releaseTime(left));
    const retainedTags = new Set(
        channelReleases
            .slice(0, keepVersions)
            .map((release) => release.tag_name)
            .filter(Boolean)
    );
    const keys = [];

    for (const release of channelReleases.slice(keepVersions)) {
        for (const asset of release.assets ?? []) {
            const fileName = asset?.name;
            if (!isDownloadAssetName(fileName) || channelFromAssetName(fileName) !== channel) {
                continue;
            }
            keys.push(`${updatePath}/${fileName}`);
        }
    }

    return { keys, retainedTags };
}

function staleFeedAssetKeys(feed, retainedTags, updatePath, channel) {
    if (!Array.isArray(feed?.Assets)) {
        return [];
    }

    const keys = [];
    for (const asset of feed.Assets) {
        const fileName = asset?.FileName;
        if (!isDownloadAssetName(fileName) || channelFromAssetName(fileName) !== channel) {
            continue;
        }

        const releaseTag = deriveReleaseTagFromAssetName(fileName);
        if (!releaseTag || !retainedTags.has(releaseTag)) {
            keys.push(`${updatePath}/${fileName}`);
        }
    }
    return keys;
}

function staleR2ObjectKeys(objectKeys, retainedTags, updatePath, channel) {
    const prefix = `${updatePath}/`;
    const keys = [];

    for (const key of objectKeys) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) {
            continue;
        }

        const fileName = key.slice(prefix.length);
        if (fileName.includes('/')) {
            continue;
        }
        if (!isDownloadAssetName(fileName) || channelFromAssetName(fileName) !== channel) {
            continue;
        }

        const releaseTag = deriveReleaseTagFromAssetName(fileName);
        if (!releaseTag || !retainedTags.has(releaseTag)) {
            keys.push(key);
        }
    }

    return keys;
}

export async function planR2ReleaseAssetPrune(projectRoot, channel, options = {}) {
    assertNonEmptyString(channel, 'release channel');

    const product = await readProduct(projectRoot);
    const keepVersions = retentionForChannel(product, channel);

    const repository = githubRepositoryFromProduct(product, {
        invalidHostMessage: 'repository.url must use github.com for R2 release asset pruning.',
    });
    const updatePath = relativeUpdatePath(product.services.updates.baseUrl);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new Error('fetch is required to plan R2 release asset pruning.');
    }

    const configuredCloudflare = cloudflareConfig(options);
    const releases = await fetchGithubReleases(repository, fetchImpl, options.token ?? null);
    const { keys, retainedTags } = staleReleaseAssetKeys(
        releases,
        keepVersions,
        updatePath,
        channel
    );
    keys.push(
        ...staleFeedAssetKeys(
            await existingFeed(product, channel, fetchImpl),
            retainedTags,
            updatePath,
            channel
        )
    );
    if (configuredCloudflare) {
        keys.push(
            ...staleR2ObjectKeys(
                await fetchR2ObjectKeys(configuredCloudflare, updatePath, fetchImpl),
                retainedTags,
                updatePath,
                channel
            )
        );
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
        cloudflare: cloudflareConfigFromEnv(process.env),
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
