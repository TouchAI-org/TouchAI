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

function nextPatchVersion(version) {
    const [major, minor, patch] = parseSemver(version).core.split('.').map(Number);
    return `${major}.${minor}.${patch + 1}`;
}

function latestStableVersionFromGit(projectRoot) {
    const normalizedProjectRoot = normalizeOptionalString(projectRoot);
    if (!normalizedProjectRoot) {
        return null;
    }

    let output;
    try {
        output = execFileSync('git', ['tag', '--list', 'v*'], {
            cwd: normalizedProjectRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
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
    const baseVersion =
        normalizeOptionalString(input.stableBaseVersion) ??
        latestStableVersionFromGit(input.projectRoot) ??
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

function releaseName(channel, version) {
    if (channel === 'beta') {
        return `TouchAI Beta ${version}`;
    }

    if (channel === 'nightly') {
        return `TouchAI Nightly ${version}`;
    }

    return `TouchAI ${version}`;
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
        releaseName: releaseName(channel, parsedVersion.version),
    };
}

async function readPackageVersion(projectRoot) {
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    return packageJson.version;
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
            '',
        ].join('\n'),
        'utf8'
    );
}

async function main() {
    const packageVersion = await readPackageVersion(process.cwd());
    const metadata = resolveReleaseMetadata({
        eventName: process.env.GITHUB_EVENT_NAME,
        refType: process.env.GITHUB_REF_TYPE,
        refName: process.env.GITHUB_REF_NAME,
        inputChannel: process.env.RELEASE_CHANNEL,
        inputVersion: process.env.RELEASE_VERSION,
        packageVersion,
        runNumber: process.env.GITHUB_RUN_NUMBER,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        projectRoot: process.cwd(),
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
