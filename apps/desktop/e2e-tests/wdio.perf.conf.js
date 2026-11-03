import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DRIVER_PORT = 4444;
let tauriDriver;
let exitRequested = false;

function requireEnv(name) {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for the RFC 710 performance run.`);
    return value;
}

function resolveTauriDriverPath() {
    const binaryName = process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver';
    const cargoBinary = path.resolve(os.homedir(), '.cargo', 'bin', binaryName);
    if (fs.existsSync(cargoBinary)) return cargoBinary;
    const lookup = spawnSync('which', [binaryName], { encoding: 'utf8' });
    const resolved = lookup.stdout?.trim();
    if (lookup.status === 0 && resolved) return resolved;
    throw new Error('tauri-driver is not installed.');
}

function closeTauriDriver() {
    exitRequested = true;
    tauriDriver?.kill();
}

function isDriverPortListening() {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: DRIVER_PORT }, () => {
            socket.end();
            resolve(true);
        });
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function waitForDriverPort(listening, timeoutMs = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if ((await isDriverPortListening()) === listening) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
        `tauri-driver port ${DRIVER_PORT} did not become ${listening ? 'available' : 'closed'}.`
    );
}

async function closeTauriDriverAndWait() {
    const child = tauriDriver;
    tauriDriver = null;
    exitRequested = true;
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
        }, 5000);
        child.once('exit', () => {
            clearTimeout(timeout);
            resolve();
        });
        child.kill('SIGTERM');
    });
    await waitForDriverPort(false, 30000);
}

process.on('exit', closeTauriDriver);
process.on('SIGINT', closeTauriDriver);
process.on('SIGTERM', closeTauriDriver);

export const config = {
    host: '127.0.0.1',
    port: DRIVER_PORT,
    specs: [[path.join(__dirname, 'perf/rfc710.e2e.js')]],
    bail: 1,
    maxInstances: 1,
    waitforTimeout: 30000,
    connectionRetryTimeout: 300000,
    capabilities: [
        {
            maxInstances: 1,
            'tauri:options': {
                application: requireEnv('TOUCHAI_PERF_BINARY'),
            },
        },
    ],
    reporters: ['spec'],
    framework: 'mocha',
    mochaOpts: {
        ui: 'bdd',
        timeout: 30 * 60 * 1000,
    },
    beforeSession: async () => {
        const appRoot = requireEnv('TOUCHAI_PERF_APP_ROOT');
        fs.mkdirSync(appRoot, { recursive: true });
        await waitForDriverPort(false, 30000);
        tauriDriver = spawn(resolveTauriDriverPath(), [], {
            stdio: [null, process.stdout, process.stderr],
            env: {
                ...process.env,
                TOUCHAI_APP_ROOT: appRoot,
                TOUCHAI_E2E: '1',
            },
        });
        tauriDriver.on('error', (error) => {
            console.error('tauri-driver error:', error);
            process.exit(1);
        });
        tauriDriver.on('exit', (code) => {
            if (!exitRequested) {
                console.error('tauri-driver exited with code:', code);
                process.exit(1);
            }
        });
        await waitForDriverPort(true, 15000);
    },
    afterSession: closeTauriDriverAndWait,
};
