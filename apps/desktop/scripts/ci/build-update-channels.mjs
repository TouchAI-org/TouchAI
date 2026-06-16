import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { versionFromAssetName } from '../update-release-assets.mjs';

const REQUIRED_SEVERITIES = ['critical', 'security', 'recommended'];
const DOWNLOAD_KINDS = ['installer', 'fullPackage', 'deltaPackage', 'updatePackage', 'asset'];
const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
}

function assertNonEmptyString(value, label) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label} must be a non-empty string.`);
    }
}

function assertNullableString(value, label) {
    if (value !== null && typeof value !== 'string') {
        throw new Error(`${label} must be a string or null.`);
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

function assertNullableNonNegativeInteger(value, label) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
        throw new Error(`${label} must be a non-negative integer or null.`);
    }
}

function assertOptionalVersion(value, label) {
    assertNullableString(value, label);
    if (value !== null && !SEMVER_PATTERN.test(value)) {
        throw new Error(`${label} must be a semantic version or null.`);
    }
}

function assertVersion(value, label) {
    assertNonEmptyString(value, label);
    if (!SEMVER_PATTERN.test(value)) {
        throw new Error(`${label} must be a semantic version.`);
    }
}

function assertPolicy(policy, channel) {
    assertObject(policy, `${channel} policy`);
    const requiredSeverity = policy.requiredSeverity ?? null;
    assertOptionalVersion(
        policy.minimumSupportedVersion ?? null,
        `${channel}.minimumSupportedVersion`
    );
    assertNullableString(requiredSeverity, `${channel}.requiredSeverity`);
    assertNullableString(policy.requiredReason ?? null, `${channel}.requiredReason`);

    if (requiredSeverity !== null && !REQUIRED_SEVERITIES.includes(requiredSeverity)) {
        throw new Error(
            `${channel}.requiredSeverity must be ${REQUIRED_SEVERITIES.join(', ')}, or null.`
        );
    }
}

function normalizePolicy(policy, channel) {
    assertPolicy(policy, channel);
    return {
        minimumSupportedVersion: policy.minimumSupportedVersion ?? null,
        requiredSeverity: policy.requiredSeverity ?? null,
        requiredReason: policy.requiredReason ?? null,
    };
}

function normalizeReleaseNotes(value, label) {
    assertNullableString(value, label);
    if (value === null) {
        return null;
    }

    const notes = value.trim();
    return notes ? notes : null;
}

function normalizeDownload(value, label) {
    assertObject(value, label);
    assertNonEmptyString(value.kind, `${label}.kind`);
    if (!DOWNLOAD_KINDS.includes(value.kind)) {
        throw new Error(`${label}.kind must be one of ${DOWNLOAD_KINDS.join(', ')}.`);
    }
    assertNonEmptyString(value.name, `${label}.name`);
    assertAbsoluteHttpsUrl(value.url, `${label}.url`);

    const sizeBytes = value.sizeBytes ?? null;
    assertNullableNonNegativeInteger(sizeBytes, `${label}.sizeBytes`);

    return {
        kind: value.kind,
        name: value.name,
        url: value.url,
        sizeBytes,
    };
}

function normalizeDownloads(value, channel) {
    const downloads = value ?? [];
    if (!Array.isArray(downloads)) {
        throw new Error(`${channel}.Latest.downloads must be an array.`);
    }

    return downloads.map((download, index) =>
        normalizeDownload(download, `${channel}.Latest.downloads[${index}]`)
    );
}

function normalizeLatestRelease(value, channel) {
    if (value === undefined || value === null) {
        return null;
    }

    assertObject(value, `${channel}.Latest`);
    assertVersion(value.version, `${channel}.Latest.version`);
    assertNonEmptyString(value.tag, `${channel}.Latest.tag`);
    assertAbsoluteHttpsUrl(value.releaseUrl, `${channel}.Latest.releaseUrl`);

    if (typeof value.prerelease !== 'boolean') {
        throw new Error(`${channel}.Latest.prerelease must be a boolean.`);
    }

    const publishedAt = value.publishedAt ?? null;
    assertNullableString(publishedAt, `${channel}.Latest.publishedAt`);

    return {
        version: value.version,
        tag: value.tag,
        releaseUrl: value.releaseUrl,
        publishedAt,
        prerelease: value.prerelease,
        releaseNotes: normalizeReleaseNotes(
            value.releaseNotes ?? null,
            `${channel}.Latest.releaseNotes`
        ),
        downloads: normalizeDownloads(value.downloads, channel),
    };
}

function relativeUpdatePath(baseUrl) {
    let url;
    try {
        url = new URL(baseUrl);
    } catch {
        throw new Error('services.updates.baseUrl must be an absolute URL.');
    }

    if (url.protocol !== 'https:') {
        throw new Error('services.updates.baseUrl must use https.');
    }

    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!path) {
        throw new Error('services.updates.baseUrl must include a path.');
    }

    return path;
}

function assertRepository(repository) {
    assertObject(repository, 'repository');
    assertAbsoluteHttpsUrl(repository.url, 'repository.url');
    assertAbsoluteHttpsUrl(repository.releasesUrl, 'repository.releasesUrl');
    assertAbsoluteHttpsUrl(repository.docsUrl, 'repository.docsUrl');
    assertAbsoluteHttpsUrl(repository.issuesUrl, 'repository.issuesUrl');
}

function assertPackaging(packaging) {
    assertObject(packaging, 'packaging');
    assertNonEmptyString(packaging.mainExe, 'packaging.mainExe');
}

function assertUpdateDeployment(deployment) {
    assertObject(deployment, 'services.updates.deployment');

    if (deployment.provider !== 'cloudflare-r2') {
        throw new Error('services.updates.deployment.provider must be cloudflare-r2.');
    }

    assertNonEmptyString(deployment.bucketName, 'services.updates.deployment.bucketName');
}

function channelEntries(channels) {
    assertObject(channels, 'services.updates.channels');
    const entries = Object.entries(channels);
    if (entries.length === 0) {
        throw new Error('services.updates.channels must include at least one channel.');
    }

    for (const [channel, channelConfig] of entries) {
        assertNonEmptyString(channel, 'update channel name');
        assertObject(channelConfig, `services.updates.channels.${channel}`);
        assertObject(channelConfig.policy, `services.updates.channels.${channel}.policy`);
    }

    return entries;
}

async function readProduct(projectRoot) {
    const product = JSON.parse(await readFile(join(projectRoot, 'product.json'), 'utf8'));
    assertObject(product, 'product.json');

    if (product.schemaVersion !== 1) {
        throw new Error('product.json schemaVersion must be 1.');
    }

    assertNonEmptyString(product.product, 'product.json product');
    assertNonEmptyString(product.displayName, 'product.json displayName');
    assertNonEmptyString(product.identifier, 'product.json identifier');
    assertRepository(product.repository);
    assertPackaging(product.packaging);

    const updates = product.services?.updates;
    assertObject(updates, 'services.updates');
    assertNonEmptyString(updates.baseUrl, 'services.updates.baseUrl');
    relativeUpdatePath(updates.baseUrl);
    assertUpdateDeployment(updates.deployment);
    channelEntries(updates.channels);

    return product;
}

function releaseUrl(product, tag) {
    return `${product.repository.releasesUrl.replace(/\/+$/g, '')}/tag/${tag}`;
}

function updateAssetUrl(product, fileName) {
    return `${product.services.updates.baseUrl.replace(/\/+$/g, '')}/${encodeURIComponent(fileName)}`;
}

function downloadKindFromFileName(fileName) {
    const lowerName = fileName.toLowerCase();

    if (lowerName.endsWith('.msi')) {
        return 'installer';
    }
    if (lowerName.endsWith('.dmg')) {
        return 'installer';
    }
    if (lowerName.endsWith('.app.tar.gz')) {
        return 'updatePackage';
    }
    if (lowerName.endsWith('.deb')) {
        return 'installer';
    }
    if (lowerName.endsWith('.rpm')) {
        return 'installer';
    }
    if (lowerName.endsWith('.appimage.tar.gz')) {
        return 'updatePackage';
    }
    if (lowerName.endsWith('.appimage')) {
        return 'installer';
    }
    if (lowerName.endsWith('-full.nupkg')) {
        return 'fullPackage';
    }
    if (lowerName.endsWith('-delta.nupkg')) {
        return 'deltaPackage';
    }

    return null;
}

function sortDownloads(downloads) {
    const order = new Map(DOWNLOAD_KINDS.map((kind, index) => [kind, index]));
    return [...downloads].sort(
        (left, right) =>
            (order.get(left.kind) ?? DOWNLOAD_KINDS.length) -
                (order.get(right.kind) ?? DOWNLOAD_KINDS.length) ||
            left.name.localeCompare(right.name)
    );
}

function mergeDownloads(...downloadLists) {
    const merged = new Map();
    for (const downloads of downloadLists) {
        for (const download of downloads ?? []) {
            const key = `${download.kind}:${download.name}`;
            if (!merged.has(key)) {
                merged.set(key, download);
            }
        }
    }
    return sortDownloads([...merged.values()]);
}

async function releaseDownloadsFromDirectory(product, releaseDir, version) {
    if (!releaseDir) {
        return [];
    }

    const entries = await readdir(releaseDir, { withFileTypes: true });
    const downloads = [];
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        if (version && !entry.name.includes(version)) {
            continue;
        }

        const kind = downloadKindFromFileName(entry.name);
        if (!kind) {
            continue;
        }

        const fileStat = await stat(join(releaseDir, entry.name));
        downloads.push({
            kind,
            name: entry.name,
            url: updateAssetUrl(product, entry.name),
            sizeBytes: fileStat.size,
        });
    }

    return sortDownloads(downloads);
}

async function releaseAssetsFromDirectory(releaseDir, channel) {
    if (!releaseDir) {
        return [];
    }

    try {
        const feed = JSON.parse(
            await readFile(join(releaseDir, `releases.${channel}.json`), 'utf8')
        );
        if (!Array.isArray(feed.Assets)) {
            return [];
        }
        return feed.Assets;
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

function latestByChannelFromRelease(product, release, fallbackPublishedAt) {
    if (!release) {
        return {};
    }

    const { channel, version, tag, prerelease, publishedAt = null } = release;
    assertNonEmptyString(channel, 'release channel');
    assertVersion(version, 'release version');
    assertNonEmptyString(tag, 'release tag');

    if (typeof prerelease !== 'boolean') {
        throw new Error('release prerelease must be a boolean.');
    }

    return {
        [channel]: {
            version,
            tag,
            releaseUrl: releaseUrl(product, tag),
            publishedAt: publishedAt ?? fallbackPublishedAt,
            prerelease,
            releaseNotes: normalizeReleaseNotes(
                release.releaseNotes ?? null,
                `${channel}.Latest.releaseNotes`
            ),
            downloads: mergeDownloads(release.downloads),
        },
    };
}

async function existingFeed(product, channel) {
    const url = `${product.services.updates.baseUrl.replace(/\/+$/g, '')}/releases.${channel}.json`;
    const response = await fetch(url);
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

async function existingFeedsByChannel(product, channels, fetchExisting) {
    if (!fetchExisting) {
        return {};
    }

    const feeds = {};
    for (const channel of channels) {
        feeds[channel] = await existingFeed(product, channel);
    }
    return feeds;
}

function feedOutput(product, channel, channelConfig, generatedAt, options) {
    const existing = options.existing ?? null;
    return {
        Assets: options.assets ?? existing?.Assets ?? [],
        SchemaVersion: 1,
        Product: product.product,
        DisplayName: product.displayName,
        Channel: channel,
        GeneratedAt: generatedAt,
        Latest: normalizeLatestRelease(options.latest ?? existing?.Latest ?? null, channel),
        Policy: normalizePolicy(channelConfig.policy, channel),
    };
}

async function copyReleaseAssets(releaseDir, outputDir, version) {
    if (!releaseDir) {
        return;
    }

    const entries = await readdir(releaseDir, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        if (entry.name.endsWith('.json') || entry.name.startsWith('RELEASES')) {
            continue;
        }
        if (!downloadKindFromFileName(entry.name)) {
            continue;
        }
        if (version && versionFromAssetName(entry.name) !== version) {
            continue;
        }
        await copyFile(join(releaseDir, entry.name), join(outputDir, entry.name));
    }
}

export async function buildUpdateChannels(projectRoot, outputRoot, now = new Date(), options = {}) {
    const product = await readProduct(projectRoot);
    const generatedAt = now.toISOString();
    const updates = product.services.updates;
    const outputDir = join(outputRoot, relativeUpdatePath(updates.baseUrl));
    const channelNames = channelEntries(updates.channels).map(([channel]) => channel);
    const release = options.release
        ? {
              ...options.release,
              releaseNotes:
                  options.release.releaseNotes ??
                  (options.release.releaseNotesFile
                      ? await readFile(options.release.releaseNotesFile, 'utf8')
                      : null),
              downloads: mergeDownloads(
                  await releaseDownloadsFromDirectory(
                      product,
                      options.release.releaseDir,
                      options.release.version
                  ),
                  options.release.downloads
              ),
              assets: await releaseAssetsFromDirectory(
                  options.release.releaseDir,
                  options.release.channel
              ),
          }
        : null;
    const existingByChannel = await existingFeedsByChannel(
        product,
        channelNames,
        Boolean(options.fetchExisting)
    );
    const latestByChannel = {
        ...Object.fromEntries(
            Object.entries(existingByChannel)
                .filter(([, feed]) => feed?.Latest)
                .map(([channel, feed]) => [channel, feed.Latest])
        ),
        ...latestByChannelFromRelease(product, release, generatedAt),
        ...(options.latestByChannel ?? {}),
    };

    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    await copyReleaseAssets(release?.releaseDir, outputDir, release?.version ?? null);

    for (const [channel, channelConfig] of channelEntries(updates.channels)) {
        const output = feedOutput(product, channel, channelConfig, generatedAt, {
            existing: existingByChannel[channel] ?? null,
            latest: latestByChannel[channel] ?? null,
            assets: release?.channel === channel ? release.assets : undefined,
        });
        await writeFile(
            join(outputDir, `releases.${channel}.json`),
            `${JSON.stringify(output, null, 4)}\n`
        );
    }
}

function booleanArg(value, label) {
    if (value === 'true' || value === 'True') {
        return true;
    }

    if (value === 'false' || value === 'False') {
        return false;
    }

    throw new Error(`${label} must be true or false.`);
}

function parseCliOptions(argv) {
    const [outputRoot, ...args] = argv;
    const options = {};

    for (let index = 0; index < args.length; index += 2) {
        const key = args[index];
        const value = args[index + 1];
        if (!key?.startsWith('--') || value === undefined) {
            throw new Error(`Invalid argument: ${key ?? ''}`);
        }
        options[key.slice(2)] = value;
    }

    const parsedOptions = {
        fetchExisting: options['fetch-existing']
            ? booleanArg(options['fetch-existing'], '--fetch-existing')
            : false,
    };

    if (options.channel || options.version || options.tag || options.prerelease) {
        for (const key of ['channel', 'version', 'tag', 'prerelease']) {
            if (!options[key]) {
                throw new Error(`--${key} is required when writing latest release metadata.`);
            }
        }

        parsedOptions.release = {
            channel: options.channel,
            version: options.version,
            tag: options.tag,
            prerelease: booleanArg(options.prerelease, '--prerelease'),
            publishedAt: options['published-at'] ?? null,
            releaseNotesFile: options['release-notes-file'] ?? null,
            releaseDir: options['release-dir'] ?? null,
        };
    }

    return { outputRoot, options: parsedOptions };
}

async function main() {
    const projectRoot = process.cwd();
    const parsed = parseCliOptions(process.argv.slice(2));
    const outputRoot = parsed.outputRoot ?? join(projectRoot, '.update-dist');
    await buildUpdateChannels(projectRoot, outputRoot, new Date(), parsed.options);
    console.log(`Update release feeds written to ${outputRoot}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
