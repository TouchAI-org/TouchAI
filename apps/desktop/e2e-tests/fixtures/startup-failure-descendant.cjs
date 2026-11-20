/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.TOUCHAI_APP_ROOT;
if (!root) {
    console.error('TOUCHAI_APP_ROOT is required');
    process.exit(2);
}

const lockPath = path.join(root, 'descendant-profile.lock');
const lockHandle = fs.openSync(lockPath, 'w');
fs.writeSync(lockHandle, 'locked');
fs.writeFileSync(path.join(root, 'descendant.pid'), String(process.pid));
let pendingWrites = 2;
function signalReady() {
    pendingWrites -= 1;
    if (pendingWrites === 0) process.send?.('ready');
}
process.stdout.write('descendant is holding stdout and stderr\n', signalReady);
process.stderr.write('descendant is holding a profile file\n', signalReady);

setInterval(() => {}, 1000);
