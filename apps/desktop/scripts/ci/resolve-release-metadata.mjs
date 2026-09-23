import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHANNELS = new Set(['stable', 'beta', 'nightly']);
const SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function normalizeOptionalString(value) {
    if (value === undefined || value === null) {
        return null;
    }

    const normalized = String(value).trim();
    return normalized.length > 0 ? normalized : null;
}

function git(projectRoot, args, gitImpl = null) {
    if (gitImpl) {
        return normalizeOptionalString(gitImpl(args)) ?? '';
    }

    return execFileSync('git', args, {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
}

function normalizeChannel(value) {
    const normalized = normalizeOptionalString(value)?.toLowerCase() ?? null;
    if (!normalized) {
        return null;
    }

    if (!CHANNELS.has(normalized)) {
        throw new Error(`Unsupported release channel: ${value}.`);
    }

    return normalized;
}

function parseSemver(version) {
    const normalized = normalizeOptionalString(version);
    if (!normalized) {
        throw new Error('Release version is required.');
    }

    const match = normalized.match(SEMVER_PATTERN);
    if (!match) {
        throw new Error(`Release version ${normalized} is not a valid semantic version.`);
    }

    return {
        version: normalized,
        core: `${match[1]}.${match[2]}.${match[3]}`,
        prerelease: match[4] ?? null,
    };
}

function prereleaseStartsWith(prerelease, prefix) {
    return prerelease === prefix || prerelease?.startsWith(`${prefix}.`);
}

function versionFromTag(refName) {
    const normalized = normalizeOptionalString(refName);
    if (!normalized?.startsWith('v')) {
        throw new Error(`Release tag ${refName ?? ''} must start with v.`);
    }

    return parseSemver(normalized.slice(1));
}

function compareCoreVersions(left, right) {
    const leftParts = parseSemver(left).core.split('.').map(Number);
    const rightParts = parseSemver(right).core.split('.').map(Number);

    for (let index = 0; index < 3; index += 1) {
        const difference = leftParts[index] - rightParts[index];
        if (difference !== 0) {
            return difference;
        }
    }

    return 0;
}

function compareSemverIdentifiers(left, right) {
    if (left === right) {
        return 0;
    }

    const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
    const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
    if (leftNumber !== null && rightNumber !== null) {
        return leftNumber - rightNumber;
    }
    if (leftNumber !== null) {
        return -1;
    }
    if (rightNumber !== null) {
        return 1;
    }
    return left.localeCompare(right);
}

function comparePrereleaseVersions(left, right) {
    const leftParts = left.split('.');
    const rightParts = right.split('.');
    const count = Math.max(leftParts.length, rightParts.length);

    for (let index = 0; index < count; index += 1) {
        const leftIdentifier = leftParts[index];
        const rightIdentifier = rightParts[index];
        if (leftIdentifier === undefined) {
            return -1;
        }
        if (rightIdentifier === undefined) {
            return 1;
        }

        const difference = compareSemverIdentifiers(leftIdentifier, rightIdentifier);
        if (difference !== 0) {
            return difference;
        }
    }

    return 0;
}

function compareSemverVersions(left, right) {
    const coreDifference = compareCoreVersions(left.version, right.version);
    if (coreDifference !== 0) {
        return coreDifference;
    }

    if (!left.prerelease && !right.prerelease) {
        return 0;
    }
    if (!left.prerelease) {
        return 1;
    }
    if (!right.prerelease) {
        return -1;
    }

    return comparePrereleaseVersions(left.prerelease, right.prerelease);
}

function nextPatchVersion(version) {
    const [major, minor, patch] = parseSemver(version).core.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}`;
}

function latestStableVersionFromGit(projectRoot, gitImpl = null) {
    const normalizedProjectRoot = normalizeOptionalString(projectRoot);
    if (!normalizedProjectRoot) {
        return null;
    }

    let output;
    try {
        output = git(normalizedProjectRoot, ['tag', '--list', 'v*'], gitImpl);
    } catch {
        return null;
    }

    const stableVersions = [];
    for (const line of output.split(/\r?\n/)) {
        const tag = normalizeOptionalString(line);
        if (!tag?.startsWith('v')) {
            continue;
        }

        try {
            const parsed = parseSemver(tag.slice(1));
            if (!parsed.prerelease) {
                stableVersions.push(parsed.version);
            }
        } catch {
            // Ignore non-SemVer tags.
        }
    }

    stableVersions.sort(compareCoreVersions);
    return stableVersions.at(-1) ?? null;
}

function targetCommitFromGit(projectRoot, gitImpl = null) {
    const normalizedProjectRoot = normalizeOptionalString(projectRoot);
    if (!normalizedProjectRoot) {
        return null;
    }

    try {
        return normalizeOptionalString(git(normalizedProjectRoot, ['rev-parse', 'HEAD'], gitImpl));
    } catch {
        return null;
    }
}

function commitFromTag(projectRoot, tag, gitImpl = null) {
    const normalizedProjectRoot = normalizeOptionalString(projectRoot);
    if (!normalizedProjectRoot) {
        return null;
    }

    try {
        return normalizeOptionalString(
            git(normalizedProjectRoot, ['rev-list', '-n', '1', tag], gitImpl)
        );
    } catch {
        return null;
    }
}

function parseNightlyTag(tag) {
    const normalized = normalizeOptionalString(tag);
    if (!normalized?.startsWith('v')) {
        return null;
    }

    try {
        const parsed = parseSemver(normalized.slice(1));
        return channelFromTagVersion(parsed) === 'nightly'
            ? {
                  tag: normalized,
                  ...parsed,
              }
            : null;
    } catch {
        return null;
    }
}

function latestNightlyFromGit(projectRoot, gitImpl = null) {
    const normalizedProjectRoot = normalizeOptionalString(projectRoot);
    if (!normalizedProjectRoot) {
        return null;
    }

    let output;
    try {
        output = git(normalizedProjectRoot, ['tag', '--list', 'v*-nightly.*'], gitImpl);
    } catch {
        return null;
    }

    const latest = output
        .split(/\r?\n/)
        .map(parseNightlyTag)
        .filter(Boolean)
        .sort(compareSemverVersions)
        .at(-1);
    if (!latest) {
        return null;
    }

    const commit = commitFromTag(normalizedProjectRoot, latest.tag, gitImpl);
    return commit ? { tag: latest.tag, commit } : null;
}

function normalizeLatestNightly(projectRoot, latestNightly, gitImpl = null) {
    if (latestNightly === null) {
        return null;
    }

    const tag = normalizeOptionalString(latestNightly?.tag);
    const commit = normalizeOptionalString(latestNightly?.commit);
    if (tag && commit) {
        return { tag, commit };
    }

    return latestNightlyFromGit(projectRoot, gitImpl);
}

function dateStamp(date) {
    const dateValue = date instanceof Date ? date : new Date(date ?? Date.now());
    if (Number.isNaN(dateValue.getTime())) {
        throw new Error('Nightly release date is invalid.');
    }

    const year = dateValue.getUTCFullYear();
    const month = String(dateValue.getUTCMonth() + 1).padStart(2, '0');
    const day = String(dateValue.getUTCDate()).padStart(2, '0');
    return `${year}${month}${day}`;
}

function runPart(value, fallback) {
    const normalized = normalizeOptionalString(value) ?? fallback;
    return normalized.replace(/[^0-9A-Za-z-]/g, '-');
}

function generatedNightlyVersion(packageVersion, input) {
    const gitImpl = typeof input.git === 'function' ? input.git : null;
    const baseVersion =
        normalizeOptionalString(input.stableBaseVersion) ??
        latestStableVersionFromGit(input.projectRoot, gitImpl) ??
        packageVersion;
    const runNumber = runPart(input.runNumber, '0');
    const runAttempt = runPart(input.runAttempt, '1');

    return `${nextPatchVersion(baseVersion)}-nightly.${dateStamp(input.date)}.${runNumber}.${runAttempt}`;
}

function channelFromTagVersion(parsedVersion) {
    if (!parsedVersion.prerelease) {
        return 'stable';
    }

    if (prereleaseStartsWith(parsedVersion.prerelease, 'beta')) {
        return 'beta';
    }

    if (prereleaseStartsWith(parsedVersion.prerelease, 'nightly')) {
        return 'nightly';
    }

    throw new Error('Prerelease tags must start with beta or nightly.');
}

function validateChannelVersion(channel, parsedVersion) {
    if (channel === 'stable' && parsedVersion.prerelease) {
        throw new Error('Stable releases must use a final semantic version.');
    }

    if (channel !== 'stable' && !parsedVersion.prerelease) {
        throw new Error(`${channel} releases must use a prerelease semantic version.`);
    }

    if (channel === 'beta' && !prereleaseStartsWith(parsedVersion.prerelease, 'beta')) {
        throw new Error('Beta releases must use a beta prerelease version.');
    }

    if (channel === 'nightly' && !prereleaseStartsWith(parsedVersion.prerelease, 'nightly')) {
        throw new Error('Nightly releases must use a nightly prerelease version.');
    }
}

function productDisplayName(productConfig) {
    const displayName = normalizeOptionalString(productConfig?.displayName);
    if (!displayName) {
        throw new Error('product.json displayName is required.');
    }

    return displayName;
}

function releaseName(version, productConfig) {
    const displayName = productDisplayName(productConfig);
    return `${displayName} v${version}`;
}

function resolvePublicationDecision(input, eventName) {
    if (eventName !== 'schedule') {
        return {
            shouldPublish: true,
            skipReason: null,
        };
    }

    const projectRoot = normalizeOptionalString(input.projectRoot) ?? process.cwd();
    const gitImpl = typeof input.git === 'function' ? input.git : null;
    const targetCommit =
        normalizeOptionalString(input.targetCommit) ?? targetCommitFromGit(projectRoot, gitImpl);
    if (!targetCommit) {
        return {
            shouldPublish: true,
            skipReason: null,
        };
    }

    const latestNightly = normalizeLatestNightly(projectRoot, input.latestNightly, gitImpl);
    if (!latestNightly) {
        return {
            shouldPublish: true,
            skipReason: null,
        };
    }

    const alreadyPublished = latestNightly.commit === targetCommit;
    return {
        shouldPublish: !alreadyPublished,
        skipReason: alreadyPublished
            ? `Latest nightly ${latestNightly.tag} already points at ${targetCommit}.`
            : null,
    };
}

export function resolveReleaseMetadata(input) {
    const eventName = normalizeOptionalString(input.eventName) ?? 'workflow_dispatch';
    const tagVersion =
        input.refType === 'tag' && normalizeOptionalString(input.refName)
            ? versionFromTag(input.refName)
            : null;

    const channel =
        tagVersion && eventName === 'push'
            ? channelFromTagVersion(tagVersion)
            : eventName === 'schedule'
              ? 'nightly'
              : (normalizeChannel(input.inputChannel) ?? 'stable');

    if (!tagVersion && channel === 'stable') {
        throw new Error('Stable releases are managed by release-please.');
    }

    const inputVersion = normalizeOptionalString(input.inputVersion);
    if (!tagVersion && !inputVersion && channel !== 'nightly') {
        throw new Error(`${channel} releases require an exact semantic version.`);
    }

    const version = tagVersion
        ? tagVersion.version
        : (inputVersion ?? generatedNightlyVersion(input.packageVersion, input));
    const parsedVersion = parseSemver(version);

    validateChannelVersion(channel, parsedVersion);

    return {
        channel,
        version: parsedVersion.version,
        tag: `v${parsedVersion.version}`,
        prerelease: channel === 'stable' ? 'False' : 'True',
        releaseName: releaseName(parsedVersion.version, input.productConfig),
        ...resolvePublicationDecision(input, eventName),
    };
}

async function readPackageVersion(projectRoot) {
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    return packageJson.version;
}

async function readProductConfig(projectRoot) {
    return JSON.parse(await readFile(join(projectRoot, 'product.json'), 'utf8'));
}

async function writeGithubOutput(metadata) {
    const outputPath = normalizeOptionalString(process.env.GITHUB_OUTPUT);
    if (!outputPath) {
        return;
    }

    await appendFile(
        outputPath,
        [
            `channel=${metadata.channel}`,
            `version=${metadata.version}`,
            `tag=${metadata.tag}`,
            `prerelease=${metadata.prerelease}`,
            `release_name=${metadata.releaseName}`,
            `should_publish=${metadata.shouldPublish ? 'true' : 'false'}`,
            `skip_reason=${metadata.skipReason ?? ''}`,
            '',
        ].join('\n'),
        'utf8'
    );
}

async function main() {
    const projectRoot = process.cwd();
    const [packageVersion, productConfig] = await Promise.all([
        readPackageVersion(projectRoot),
        readProductConfig(projectRoot),
    ]);
    const metadata = resolveReleaseMetadata({
        eventName: process.env.GITHUB_EVENT_NAME,
        refType: process.env.GITHUB_REF_TYPE,
        refName: process.env.GITHUB_REF_NAME,
        inputChannel: process.env.RELEASE_CHANNEL,
        inputVersion: process.env.RELEASE_VERSION,
        packageVersion,
        runNumber: process.env.GITHUB_RUN_NUMBER,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        targetCommit: process.env.TARGET_COMMIT ?? process.env.GITHUB_SHA,
        projectRoot,
        productConfig,
    });

    await writeGithubOutput(metadata);
    console.log(JSON.stringify(metadata, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
