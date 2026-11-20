import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveComparison } from './comparison.mjs';
import {
    artifactsRoot,
    baselineSnapshot,
    currentSnapshot,
    evidenceRoot,
    logsRoot,
    MANIFEST_VERSION,
    manifestsRoot,
    repoRoot,
    snapshotsRoot,
} from './config.mjs';
import {
    ensureDirectory,
    nowIso,
    removeManagedDirectory,
    sha256File,
    sha256Text,
    writeJson,
} from './io.mjs';
import { runSync } from './process.mjs';

function listSnapshotEntries(root) {
    const entries = [];
    const walk = (directory) => {
        for (const entry of fs
            .readdirSync(directory, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name === '.git') continue;
            const absolute = path.join(directory, entry.name);
            const relative = path.relative(root, absolute);
            if (entry.isSymbolicLink()) {
                const target = fs.readlinkSync(absolute);
                entries.push({
                    path: relative,
                    type: 'symlink',
                    target,
                    sha256: sha256Text(target),
                });
            } else if (entry.isDirectory()) {
                walk(absolute);
            } else if (entry.isFile()) {
                entries.push({
                    path: relative,
                    type: 'file',
                    size: fs.statSync(absolute).size,
                    sha256: sha256File(absolute),
                });
            }
        }
    };
    walk(root);
    return entries;
}

function writeSourceManifest(arm, snapshot, comparison) {
    const entries = listSnapshotEntries(snapshot);
    const manifest = {
        version: MANIFEST_VERSION,
        arm,
        comparison,
        generatedAt: nowIso(),
        snapshot,
        entries,
        entryCount: entries.length,
    };
    const manifestPath = path.join(manifestsRoot, `${arm}-source-manifest.json`);
    writeJson(manifestPath, manifest);
    return {
        path: manifestPath,
        sha256: sha256File(manifestPath),
        entryCount: entries.length,
    };
}
export function linkSnapshotDependencies(snapshot, checkout = repoRoot) {
    const packages = fs
        .readdirSync(path.join(snapshot, 'packages'))
        .filter((name) => fs.existsSync(path.join(snapshot, 'packages', name, 'package.json')));
    const owners = ['', 'apps/desktop', ...packages.map((name) => `packages/${name}`)];
    for (const owner of owners) {
        const source = path.join(checkout, owner, 'node_modules');
        const target = path.join(snapshot, owner, 'node_modules');
        if (!fs.existsSync(source)) throw new Error(`Required node_modules is missing: ${source}`);
        fs.mkdirSync(target, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            if (entry === '@touchai') continue;
            fs.symlinkSync(
                fs.realpathSync(path.join(source, entry)),
                path.join(target, entry),
                'dir'
            );
        }
        // Whole-directory links would resolve @touchai imports back into the live checkout.
        fs.mkdirSync(path.join(target, '@touchai'), { recursive: true });
        for (const name of packages) {
            fs.symlinkSync(
                path.join(snapshot, 'packages', name),
                path.join(target, '@touchai', name),
                'dir'
            );
        }
    }
}

function prepareSnapshot(snapshot, commit) {
    removeManagedDirectory(snapshot, snapshotsRoot);
    ensureDirectory(snapshot);
    const archive = path.join(artifactsRoot, `${path.basename(snapshot)}.tar`);
    runSync('git', ['archive', '--format=tar', `--output=${archive}`, commit], {
        log: path.join(logsRoot, 'prepare.log'),
    });
    runSync('tar', ['-xf', archive, '-C', snapshot], { log: path.join(logsRoot, 'prepare.log') });
    fs.rmSync(archive, { force: true });
}

export function prepareSnapshots(args) {
    const comparison = resolveComparison(repoRoot, args.baseline, args.candidate ?? 'HEAD');
    ensureDirectory(logsRoot);
    ensureDirectory(manifestsRoot);
    prepareSnapshot(baselineSnapshot, comparison.baselineCommit);
    prepareSnapshot(currentSnapshot, comparison.candidateCommit);
    for (const file of [
        'pnpm-lock.yaml',
        'package.json',
        'apps/desktop/package.json',
        ...fs
            .readdirSync(path.join(currentSnapshot, 'packages'))
            .map((name) => `packages/${name}/package.json`),
    ]) {
        if (
            sha256File(path.join(currentSnapshot, file)) !== sha256File(path.join(repoRoot, file))
        ) {
            throw new Error(`Installed dependency checkout differs from candidate: ${file}`);
        }
    }
    const baseline = writeSourceManifest('baseline', baselineSnapshot, comparison);
    const current = writeSourceManifest('current', currentSnapshot, comparison);
    linkSnapshotDependencies(baselineSnapshot);
    linkSnapshotDependencies(currentSnapshot);
    const manifest = {
        version: MANIFEST_VERSION,
        generatedAt: nowIso(),
        repoRoot,
        evidenceRoot,
        artifactsRoot,
        comparison,
        baseline,
        current,
        environment: {
            node: process.version,
            pnpm: runSync('pnpm', ['--version']).stdout.trim(),
            rustc: runSync('rustc', ['--version']).stdout.trim(),
            cargo: runSync('cargo', ['--version']).stdout.trim(),
            webkit: runSync('bash', [
                '-lc',
                "dpkg-query -W -f='${Version}' libwebkit2gtk-4.1-0 2>/dev/null || true",
            ]).stdout.trim(),
            kernel: os.release(),
            platform: `${process.platform}-${process.arch}`,
            cpuCount: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
            ci: {
                provider: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
                workflow: process.env.GITHUB_WORKFLOW ?? null,
                runId: process.env.GITHUB_RUN_ID ?? null,
                runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
                runnerName: process.env.RUNNER_NAME ?? null,
                runnerOs: process.env.RUNNER_OS ?? null,
                imageOs: process.env.ImageOS ?? null,
                imageVersion: process.env.ImageVersion ?? null,
            },
        },
    };
    const manifestPath = path.join(evidenceRoot, 'source-manifest.json');
    writeJson(manifestPath, manifest);
    return manifest;
}
