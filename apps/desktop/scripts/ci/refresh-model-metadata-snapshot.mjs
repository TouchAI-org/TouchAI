#!/usr/bin/env node
/**
 * Refreshes the bundled model metadata snapshot while the Release Please pull
 * request is being updated, so a release ships with a current catalog.
 *
 * The refresh is fail-open: when the upstream catalog is unavailable or looks
 * truncated, the snapshot already on the branch is kept and the reason is
 * reported instead of failing the release PR.
 */
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
    MODEL_METADATA_SNAPSHOT_PATH,
    updateModelMetadataSnapshot,
} from '../update-model-metadata.mjs';

async function readSnapshot(targetPath) {
    try {
        return await readFile(targetPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function digestOf(content) {
    return createHash('sha256').update(content).digest('hex');
}

function describeError(error) {
    return String(error?.message ?? error)
        .replace(/\s+/g, ' ')
        .trim();
}

export async function refreshModelMetadataSnapshot({ projectRoot, sourceUrl, fetchImpl } = {}) {
    const targetPath = join(projectRoot, MODEL_METADATA_SNAPSHOT_PATH);

    try {
        const previous = await readSnapshot(targetPath);
        const { providers, models } = await updateModelMetadataSnapshot({
            projectRoot,
            sourceUrl,
            fetchImpl,
        });
        const next = (await readSnapshot(targetPath)) ?? '';

        return {
            status: next === previous ? 'unchanged' : 'updated',
            targetPath,
            providers,
            models,
            digest: digestOf(next),
        };
    } catch (error) {
        return { status: 'skipped', targetPath, reason: describeError(error) };
    }
}

function formatSummary(result) {
    const lines = ['## Model metadata snapshot', ''];

    if (result.status === 'skipped') {
        lines.push('- Status: skipped (kept the snapshot already on the branch)');
        lines.push(`- Reason: ${result.reason}`);
    } else {
        lines.push(`- Status: ${result.status}`);
        lines.push(`- Providers: ${result.providers}`);
        lines.push(`- Models: ${result.models}`);
        lines.push(`- sha256: \`${result.digest}\``);
    }

    lines.push('');

    return `${lines.join('\n')}\n`;
}

async function main() {
    const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
    const result = await refreshModelMetadataSnapshot({ projectRoot });
    const summary = formatSummary(result);

    process.stdout.write(summary);

    if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
    }

    if (result.status === 'skipped') {
        console.warn(`::warning title=Model metadata snapshot not refreshed::${result.reason}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.warn(
            `::warning title=Model metadata snapshot not refreshed::${describeError(error)}`
        );
    });
}
