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
        windowsHide: true,
    }
);

descendant.once('error', (error) => {
    console.error(`Could not start descendant: ${error}`);
    process.exit(3);
});

descendant.once('message', (message) => {
    if (message !== 'ready') return;
    process.stdout.write('parent shutting down with a live descendant\n', () => process.exit(17));
});
