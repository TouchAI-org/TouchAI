import path from 'node:path';

import { evidenceRoot } from './config.mjs';
import { readJsonFile } from './io.mjs';
import { runSync } from './process.mjs';

export function resolveComparison(repository, baselineRef, candidateRef = 'HEAD') {
    if (!baselineRef)
        throw new Error('--baseline <commit> is required; choose a comparable base explicitly.');
    const git = (args) => runSync('git', args, { cwd: repository }).stdout.trim();
    const resolve = (ref) => git(['rev-parse', '--verify', `${ref}^{commit}`]);
    const baselineCommit = resolve(baselineRef);
    const candidateCommit = resolve(candidateRef);
    runSync('git', ['merge-base', '--is-ancestor', baselineCommit, candidateCommit], {
        cwd: repository,
    });
    const dependencyPaths = [
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'package.json',
        'apps/desktop/package.json',
        'apps/desktop/src-tauri/Cargo.toml',
        'apps/desktop/src-tauri/Cargo.lock',
        'packages',
    ];
    const changed = git([
        'diff',
        '--name-only',
        baselineCommit,
        candidateCommit,
        '--',
        ...dependencyPaths,
    ])
        .split('\n')
        .filter((name) => {
            if (!name || (name.startsWith('packages/') && !name.endsWith('/package.json')))
                return false;
            if (!name.endsWith('package.json')) return true;
            const inputs = (commit) => {
                const manifest = JSON.parse(git(['show', `${commit}:${name}`]));
                return [
                    'dependencies',
                    'devDependencies',
                    'optionalDependencies',
                    'peerDependencies',
                    'pnpm',
                    'packageManager',
                ].map((field) => manifest[field]);
            };
            return (
                JSON.stringify(inputs(baselineCommit)) !== JSON.stringify(inputs(candidateCommit))
            );
        });
    if (changed.length)
        throw new Error(
            `Comparable arms require identical dependency manifests: ${changed.join(', ')}`
        );
    const baselineData = git(['rev-parse', `${baselineCommit}:apps/desktop/src/database`]);
    const candidateData = git(['rev-parse', `${candidateCommit}:apps/desktop/src/database`]);
    if (baselineData !== candidateData)
        throw new Error('Comparable arms require byte-identical database artifacts.');
    return { baselineCommit, candidateCommit, databaseTree: baselineData };
}

export function readComparison() {
    const comparison = readJsonFile(path.join(evidenceRoot, 'source-manifest.json'))?.comparison;
    if (!comparison?.baselineCommit || !comparison?.candidateCommit) {
        throw new Error(
            'Prepare an explicit baseline/candidate comparison before building or measuring.'
        );
    }
    return comparison;
}
