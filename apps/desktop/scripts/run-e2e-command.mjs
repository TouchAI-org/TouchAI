import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const e2eRoot = path.join(desktopRoot, 'e2e-tests');
const updateVisualBaselines = process.argv.includes('--update-baselines');

/**
 * `@wdio/visual-service` reads its update switch from the raw process argv
 * (`--update-visual-baseline`), not from an env var, so the flag has to be
 * forwarded to the `wdio` process itself. The env var alone only covers the
 * auto-save path, which creates missing baselines but never replaces existing
 * ones.
 */
const wdioArguments = [
    'run',
    'wdio.conf.js',
    ...(updateVisualBaselines ? ['--update-visual-baseline'] : []),
];

const result = spawnSync('wdio', wdioArguments, {
    cwd: e2eRoot,
    env: {
        ...process.env,
        ...(updateVisualBaselines ? { UPDATE_VISUAL_BASELINE: '1' } : {}),
    },
    shell: true,
    stdio: 'inherit',
});

if (typeof result.status === 'number') {
    process.exit(result.status);
}

process.exit(1);
