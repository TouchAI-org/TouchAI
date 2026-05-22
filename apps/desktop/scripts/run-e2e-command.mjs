import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const e2eRoot = path.join(desktopRoot, 'e2e-tests');

const result = spawnSync('wdio', ['run', 'wdio.conf.js'], {
    cwd: e2eRoot,
    env: process.env,
    shell: true,
    stdio: 'inherit',
});

if (typeof result.status === 'number') {
    process.exit(result.status);
}

process.exit(1);
