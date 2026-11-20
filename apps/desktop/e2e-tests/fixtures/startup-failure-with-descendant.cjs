/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = process.env.TOUCHAI_APP_ROOT;
if (!root) {
    console.error('TOUCHAI_APP_ROOT is required');
    process.exit(2);
}

const intermediate = spawn(
    process.execPath,
    [path.join(__dirname, 'startup-failure-intermediate.cjs')],
    {
        env: {
            ...process.env,
            TOUCHAI_APP_ROOT: root,
        },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        windowsHide: true,
    }
);

let ready = false;
intermediate.once('error', (error) => {
    console.error(`Could not start intermediate: ${error}`);
    process.exit(3);
});

intermediate.once('message', (message) => {
    if (message === 'ready') ready = true;
});

intermediate.once('exit', (code) => {
    if (code !== 23 || !ready) {
        console.error(`Intermediate exited unexpectedly: code=${code} ready=${ready}`);
        process.exit(3);
    }
    process.stdout.write('parent shutting down with a live descendant\n', () => process.exit(17));
});
