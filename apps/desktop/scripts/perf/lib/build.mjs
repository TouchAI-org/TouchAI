import fs from 'node:fs';
import path from 'node:path';

import { readComparison } from './comparison.mjs';
import {
    arms,
    artifactsRoot,
    baselineSnapshot,
    binaryPathByArm,
    buildTarget,
    currentSnapshot,
    evidenceRoot,
    logsRoot,
} from './config.mjs';
import {
    ensureDirectory,
    nowIso,
    readJsonFile,
    removeManagedDirectory,
    sha256File,
    writeJson,
} from './io.mjs';
import { runInCgroup } from './process.mjs';
import { verifyPreparedSnapshot } from './snapshots.mjs';

export function verifyBuiltArms() {
    const comparison = readComparison();
    const source = readJsonFile(path.join(evidenceRoot, 'source-manifest.json'));
    const builds = readJsonFile(path.join(evidenceRoot, 'builds.json'))?.builds ?? [];
    for (const arm of arms) {
        const build = builds.find((entry) => entry.arm === arm);
        if (
            JSON.stringify(build?.comparison) !== JSON.stringify(comparison) ||
            !source?.[arm]?.sha256 ||
            build?.sourceManifestSha256 !== source[arm].sha256 ||
            build?.binarySha256 !== sha256File(binaryPathByArm[arm])
        ) {
            throw new Error(
                `The ${arm} binary does not belong to the prepared comparison; rebuild it.`
            );
        }
    }
}

async function buildArm(arm, signal) {
    signal?.throwIfAborted();
    const snapshot = arm === 'baseline' ? baselineSnapshot : currentSnapshot;
    verifyPreparedSnapshot(arm, snapshot);
    const tauriBinary = path.join(snapshot, 'apps/desktop/node_modules/.bin/tauri');
    if (!fs.existsSync(tauriBinary)) {
        throw new Error(`Tauri CLI is missing from ${snapshot}.`);
    }
    removeManagedDirectory(buildTarget, artifactsRoot);
    const tmp = path.join(artifactsRoot, 'tmp', arm);
    removeManagedDirectory(tmp, artifactsRoot);
    ensureDirectory(tmp);
    ensureDirectory(buildTarget);
    const log = path.join(logsRoot, `build-${arm}.log`);
    const env = {
        ...process.env,
        CARGO_BUILD_JOBS: process.env.TOUCHAI_PERF_CARGO_JOBS ?? '1',
        CARGO_INCREMENTAL: '0',
        CARGO_PROFILE_RELEASE_DEBUG: '0',
        CARGO_TARGET_DIR: buildTarget,
        NODE_OPTIONS: '--max-old-space-size=2048',
        TMP: tmp,
        TEMP: tmp,
        TMPDIR: tmp,
    };

    let safeToClean = true;
    try {
        const result = await runInCgroup({
            label: `build-${arm}`,
            command: tauriBinary,
            args: ['build', '--no-bundle'],
            cwd: path.join(snapshot, 'apps/desktop'),
            env,
            log,
            signal,
        });
        signal?.throwIfAborted();
        if (result.exitCode !== 0) {
            throw new Error(`Fat-LTO release build for ${arm} exited ${result.exitCode}.`);
        }
        const outputBinary = path.join(buildTarget, 'release/TouchAI');
        if (!fs.existsSync(outputBinary)) {
            throw new Error(`Release binary was not produced at ${outputBinary}.`);
        }
        const destination = binaryPathByArm[arm];
        ensureDirectory(path.dirname(destination));
        fs.copyFileSync(outputBinary, destination);
        fs.chmodSync(destination, 0o755);
        return {
            ...result,
            arm,
            comparison: readComparison(),
            binary: path.relative(evidenceRoot, destination),
            sourceManifestSha256: readJsonFile(path.join(evidenceRoot, 'source-manifest.json'))[arm]
                .sha256,
            binarySha256: sha256File(destination),
            binarySize: fs.statSync(destination).size,
        };
    } catch (error) {
        safeToClean = error.code !== 'PERF_CLEANUP_FAILED';
        throw error;
    } finally {
        if (safeToClean) {
            removeManagedDirectory(buildTarget, artifactsRoot);
            removeManagedDirectory(tmp, artifactsRoot);
        }
    }
}

export async function buildBoth(signal) {
    ensureDirectory(logsRoot);
    fs.rmSync(path.join(evidenceRoot, 'builds.json'), { force: true });
    const results = [];
    for (const arm of arms) {
        const result = await buildArm(arm, signal);
        results.push(result);
        writeJson(path.join(evidenceRoot, 'builds.json'), {
            generatedAt: nowIso(),
            builds: results,
        });
    }
    return results;
}
