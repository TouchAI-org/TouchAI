import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_SEVERITIES = ['critical', 'security', 'recommended'];
const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SEMVER_CAPTURE_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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

function normalizeLatestRelease(value, channel) {
    if (value === undefined || value === null) {
        return null;
    }

    assertObject(value, `${channel}.latest`);
    assertVersion(value.version, `${channel}.latest.version`);
    assertNonEmptyString(value.tag, `${channel}.latest.tag`);
    assertAbsoluteHttpsUrl(value.releaseUrl, `${channel}.latest.releaseUrl`);

    if (typeof value.prerelease !== 'boolean') {
        throw new Error(`${channel}.latest.prerelease must be a boolean.`);
    }

    const publishedAt = value.publishedAt ?? null;
    assertNullableString(publishedAt, `${channel}.latest.publishedAt`);

    return {
        version: value.version,
        tag: value.tag,
        releaseUrl: value.releaseUrl,
        publishedAt,
        prerelease: value.prerelease,
    };
}

function channelOutput(product, channel, channelConfig, generatedAt, latestRelease) {
    return {
        schemaVersion: 1,
        product: product.product,
        displayName: product.displayName,
        channel,
        generatedAt,
        latest: normalizeLatestRelease(latestRelease, channel),
        policy: normalizePolicy(channelConfig.policy, channel),
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

    if (deployment.provider !== 'cloudflare-pages') {
        throw new Error('services.updates.deployment.provider must be cloudflare-pages.');
    }

    assertNonEmptyString(deployment.projectName, 'services.updates.deployment.projectName');
    assertNonEmptyString(deployment.branch, 'services.updates.deployment.branch');
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

function parseVersion(value) {
    const match = value.match(SEMVER_CAPTURE_PATTERN);
    if (!match) {
        return null;
    }

    return {
        version: value,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ?? null,
    };
}

function channelFromVersion(parsedVersion) {
    if (!parsedVersion.prerelease) {
        return 'stable';
    }

    const firstLabel = parsedVersion.prerelease.split('.')[0];
    if (firstLabel === 'beta' || firstLabel === 'nightly') {
        return firstLabel;
    }

    return null;
}

function comparePrerelease(left, right) {
    if (!left && !right) {
        return 0;
    }

    if (!left) {
        return 1;
    }

    if (!right) {
        return -1;
    }

    const leftParts = left.split('.');
    const rightParts = right.split('.');
    const length = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < length; index += 1) {
        const leftPart = leftParts[index];
        const rightPart = rightParts[index];
        if (leftPart === undefined) {
            return -1;
        }
        if (rightPart === undefined) {
            return 1;
        }
        if (leftPart === rightPart) {
            continue;
        }

        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        if (leftNumeric && rightNumeric) {
            return Number(leftPart) - Number(rightPart);
        }
        if (leftNumeric) {
            return -1;
        }
        if (rightNumeric) {
            return 1;
        }
        return leftPart.localeCompare(rightPart);
    }

    return 0;
}

function compareVersions(left, right) {
    return (
        left.major - right.major ||
        left.minor - right.minor ||
        left.patch - right.patch ||
        comparePrerelease(left.prerelease, right.prerelease)
    );
}

function releaseCandidateFromGithubRelease(product, release) {
    if (!release || release.draft) {
        return null;
    }

    const tag = release.tag_name;
    if (typeof tag !== 'string' || !tag.startsWith('v')) {
        return null;
    }

    const parsedVersion = parseVersion(tag.slice(1));
    if (!parsedVersion) {
        return null;
    }

    const channel = channelFromVersion(parsedVersion);
    if (!channel) {
        return null;
    }

    return {
        channel,
        latest: {
            version: parsedVersion.version,
            tag,
            releaseUrl: release.html_url ?? releaseUrl(product, tag),
            publishedAt: release.published_at ?? null,
            prerelease: Boolean(release.prerelease),
        },
        parsedVersion,
    };
}

function latestByChannelFromGithubReleases(product, releases) {
    const latest = {};
    for (const release of releases) {
        const candidate = releaseCandidateFromGithubRelease(product, release);
        if (!candidate) {
            continue;
        }

        const existing = latest[candidate.channel];
        if (
            !existing ||
            compareVersions(candidate.parsedVersion, existing.parsedVersion) > 0 ||
            (compareVersions(candidate.parsedVersion, existing.parsedVersion) === 0 &&
                String(candidate.latest.publishedAt ?? '') >
                    String(existing.latest.publishedAt ?? ''))
        ) {
            latest[candidate.channel] = candidate;
        }
    }

    return Object.fromEntries(
        Object.entries(latest).map(([channel, candidate]) => [channel, candidate.latest])
    );
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
        },
    };
}

async function githubReleases(githubRepository, githubToken) {
    if (!githubRepository) {
        return [];
    }

    assertNonEmptyString(githubRepository, 'github repository');
    const headers = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'TouchAI update channel builder',
    };
    if (githubToken) {
        headers.Authorization = `Bearer ${githubToken}`;
    }

    const response = await fetch(
        `https://api.github.com/repos/${githubRepository}/releases?per_page=100`,
        { headers }
    );
    if (!response.ok) {
        throw new Error(`Failed to list GitHub releases: HTTP ${response.status}`);
    }

    return response.json();
}

export async function buildUpdateChannels(projectRoot, outputRoot, now = new Date(), options = {}) {
    const product = await readProduct(projectRoot);
    const generatedAt = now.toISOString();
    const updates = product.services.updates;
    const outputDir = join(outputRoot, relativeUpdatePath(updates.baseUrl), 'channels');
    const releases = await githubReleases(options.githubRepository, options.githubToken);
    const latestByChannel = {
        ...latestByChannelFromGithubReleases(product, releases),
        ...latestByChannelFromRelease(product, options.release, generatedAt),
        ...(options.latestByChannel ?? {}),
    };

    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });

    for (const [channel, channelConfig] of channelEntries(updates.channels)) {
        const output = channelOutput(
            product,
            channel,
            channelConfig,
            generatedAt,
            latestByChannel[channel] ?? null
        );
        await writeFile(join(outputDir, `${channel}.json`), `${JSON.stringify(output, null, 4)}\n`);
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
        githubRepository: options['github-repository'] ?? null,
        githubToken: process.env.GITHUB_TOKEN ?? null,
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
        };
    }

    return { outputRoot, options: parsedOptions };
}

async function main() {
    const projectRoot = process.cwd();
    const parsed = parseCliOptions(process.argv.slice(2));
    const outputRoot = parsed.outputRoot ?? join(projectRoot, '.update-dist');
    await buildUpdateChannels(projectRoot, outputRoot, new Date(), parsed.options);
    console.log(`Update channel JSON written to ${outputRoot}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
