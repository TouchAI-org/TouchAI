/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = process.env.TOUCHAI_APP_ROOT;
if (!root) {
    console.error('TOUCHAI_APP_ROOT is required');
    process.exit(2);
}

const descendant = spawn(
    process.execPath,
    [path.join(__dirname, 'startup-failure-descendant.cjs')],
    {
        env: {
            ...process.env,
            TOUCHAI_APP_ROOT: root,
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        // Detached children escape libuv's kill-on-close job on Windows, so the
        // fixture proves cleanup works when a descendant outlives its parent.
        detached: process.platform === 'win32',
        windowsHide: true,
    }
);

descendant.once('error', (error) => {
    console.error(`Could not start descendant: ${error}`);
    process.exit(3);
});

descendant.once('message', (message) => {
    if (message !== 'ready') return;
    let pending = 2;
    function finish() {
        pending -= 1;
        if (pending === 0) process.exit(23);
    }
    process.stdout.write('intermediate exiting before its descendant\n', finish);
    process.send?.('ready', finish);
});
