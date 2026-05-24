import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED_SEVERITIES = ['critical', 'security', 'recommended'];
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

function assertOptionalVersion(value, label) {
    assertNullableString(value, label);
    if (value !== null && !SEMVER_PATTERN.test(value)) {
        throw new Error(`${label} must be a semantic version or null.`);
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

function channelOutput(product, channel, channelConfig, generatedAt) {
    return {
        schemaVersion: 1,
        product: product.product,
        displayName: product.displayName,
        channel,
        generatedAt,
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

export async function buildUpdateChannels(projectRoot, outputRoot, now = new Date()) {
    const product = await readProduct(projectRoot);
    const generatedAt = now.toISOString();
    const updates = product.services.updates;
    const outputDir = join(outputRoot, relativeUpdatePath(updates.baseUrl), 'channels');

    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });

    for (const [channel, channelConfig] of channelEntries(updates.channels)) {
        const output = channelOutput(product, channel, channelConfig, generatedAt);
        await writeFile(join(outputDir, `${channel}.json`), `${JSON.stringify(output, null, 4)}\n`);
    }
}

async function main() {
    const projectRoot = process.cwd();
    const outputRoot = process.argv[2] ?? join(projectRoot, '.update-dist');
    await buildUpdateChannels(projectRoot, outputRoot);
    console.log(`Update channel JSON written to ${outputRoot}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
