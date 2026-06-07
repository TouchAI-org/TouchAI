import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    assertNonEmptyString,
    githubRepositoryFromProduct,
    relativeUpdatePath,
} from '../update-release-assets.mjs';

function tomlString(value) {
    return JSON.stringify(value);
}

function normalizePath(value) {
    return value.replaceAll('\\', '/');
}

export function buildCloudflareUpdateWorkerConfig(product, options) {
    assertNonEmptyString(product?.repository?.url, 'repository.url');
    assertNonEmptyString(product?.services?.updates?.baseUrl, 'services.updates.baseUrl');

    const deployment = product.services.updates.deployment;
    if (deployment?.provider !== 'cloudflare-r2') {
        throw new Error('services.updates.deployment.provider must be cloudflare-r2.');
    }

    assertNonEmptyString(deployment.workerName, 'services.updates.deployment.workerName');
    assertNonEmptyString(deployment.bucketName, 'services.updates.deployment.bucketName');
    assertNonEmptyString(deployment.hostname, 'services.updates.deployment.hostname');
    assertNonEmptyString(
        deployment.compatibilityDate,
        'services.updates.deployment.compatibilityDate'
    );
    assertNonEmptyString(options?.workerScriptPath, 'worker script path');

    return `${[
        `name = ${tomlString(deployment.workerName)}`,
        `main = ${tomlString(normalizePath(options.workerScriptPath))}`,
        `compatibility_date = ${tomlString(deployment.compatibilityDate)}`,
        '',
        '[[routes]]',
        `pattern = ${tomlString(deployment.hostname)}`,
        'custom_domain = true',
        '',
        '[[r2_buckets]]',
        'binding = "UPDATE_BUCKET"',
        `bucket_name = ${tomlString(deployment.bucketName)}`,
        '',
        '[vars]',
        `UPDATE_BASE_PATH = ${tomlString(relativeUpdatePath(product.services.updates.baseUrl))}`,
        `GITHUB_REPOSITORY = ${tomlString(
            githubRepositoryFromProduct(product, {
                invalidHostMessage: 'repository.url must use github.com for the update proxy.',
            })
        )}`,
    ].join('\n')}\n`;
}

export async function writeCloudflareUpdateWorkerConfig(projectRoot, outputPath) {
    assertNonEmptyString(projectRoot, 'project root');
    assertNonEmptyString(outputPath, 'output path');

    const resolvedProjectRoot = resolve(projectRoot);
    const resolvedOutputPath = resolve(outputPath);
    const product = JSON.parse(await readFile(join(resolvedProjectRoot, 'product.json'), 'utf8'));
    const workerScriptPath = relative(
        dirname(resolvedOutputPath),
        join(resolvedProjectRoot, 'scripts/cloudflare/update-proxy-worker.mjs')
    );

    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    await writeFile(
        resolvedOutputPath,
        buildCloudflareUpdateWorkerConfig(product, { workerScriptPath }),
        'utf8'
    );
}

function parseArgs(argv) {
    const [outputPath] = argv;
    if (!outputPath) {
        throw new Error(
            'Usage: node scripts/ci/write-cloudflare-update-worker-config.mjs <output-path>'
        );
    }
    return { outputPath };
}

async function main() {
    const { outputPath } = parseArgs(process.argv.slice(2));
    await writeCloudflareUpdateWorkerConfig(process.cwd(), outputPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
