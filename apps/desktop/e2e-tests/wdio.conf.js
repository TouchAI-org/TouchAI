import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { resolveE2eAppBinaryPath, resolveTauriBuildArgs } from './wdio.paths.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const runtimeRoot = path.resolve(repoRoot, '.e2e-runtime');

let tauriDriver;
let exitRequested = false;
let sessionRuntimePath;

function resolveCargoTargetDirectory() {
    if (process.env.TOUCHAI_CARGO_TARGET_DIR) {
        return path.isAbsolute(process.env.TOUCHAI_CARGO_TARGET_DIR)
            ? process.env.TOUCHAI_CARGO_TARGET_DIR
            : path.resolve(repoRoot, process.env.TOUCHAI_CARGO_TARGET_DIR);
    }

    const temporaryTargetDirectory = path.resolve(resolveTempDirectory(), 'touchai-cargo-target');
    try {
        fs.mkdirSync(temporaryTargetDirectory, { recursive: true });
        return temporaryTargetDirectory;
    } catch {
        return path.resolve(desktopRoot, 'src-tauri', 'target');
    }
}

function resolveAppBinaryPath() {
    return resolveE2eAppBinaryPath(resolveCargoTargetDirectory());
}

function assertBuiltAppExists() {
    const appBinaryPath = resolveAppBinaryPath();

    if (!fs.existsSync(appBinaryPath)) {
        throw new Error(
            `TouchAI E2E binary was not produced at ${appBinaryPath}. Check the Tauri build output above.`
        );
    }

    return appBinaryPath;
}

function resolveTempDirectory() {
    if (process.env.TOUCHAI_TEST_TEMP) {
        return process.env.TOUCHAI_TEST_TEMP;
    }

    const legacyWorkspaceTemp = 'G:\\codex-temp';
    if (fs.existsSync(legacyWorkspaceTemp)) {
        return legacyWorkspaceTemp;
    }

    const workspaceTemp = path.resolve(runtimeRoot, 'tmp');
    try {
        fs.mkdirSync(workspaceTemp, { recursive: true });
        return workspaceTemp;
    } catch {
        // Fall through to system temp directories.
    }

    return process.env.TEMP ?? process.env.TMP;
}

function resolveTauriDriverPath() {
    const binaryName = process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver';
    const cargoBinary = path.resolve(os.homedir(), '.cargo', 'bin', binaryName);

    if (fs.existsSync(cargoBinary)) {
        return cargoBinary;
    }

    throw new Error(
        'tauri-driver is not installed. Run `cargo install tauri-driver --locked` first.'
    );
}

function resolveNativeDriverPath() {
    if (process.env.TOUCHAI_MSEDGEDRIVER_PATH) {
        return process.env.TOUCHAI_MSEDGEDRIVER_PATH;
    }

    if (process.platform !== 'win32') {
        return undefined;
    }

    const workspaceDriver = path.resolve(repoRoot, '.e2e-tools', 'msedgedriver.exe');
    if (fs.existsSync(workspaceDriver)) {
        return workspaceDriver;
    }

    const pathLookup = spawnSync('where', ['msedgedriver'], {
        encoding: 'utf8',
        shell: true,
    });

    if (pathLookup.status === 0) {
        const resolvedPath = pathLookup.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);

        if (resolvedPath) {
            return resolvedPath;
        }
    }

    throw new Error(
        'msedgedriver.exe was not found. Install a matching Edge driver via the official Tauri WebDriver docs or set TOUCHAI_MSEDGEDRIVER_PATH.'
    );
}

function closeTauriDriver() {
    exitRequested = true;
    tauriDriver?.kill();
}

async function waitForDriverServer(port, timeoutMs = 15000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        const connected = await new Promise((resolve) => {
            const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
                socket.end();
                resolve(true);
            });

            socket.on('error', () => {
                socket.destroy();
                resolve(false);
            });
        });

        if (connected) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`tauri-driver did not start listening on port ${port} within ${timeoutMs}ms.`);
}

function registerShutdownCleanup(handler) {
    const cleanup = () => {
        try {
            handler();
        } finally {
            process.exit();
        }
    };

    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('SIGHUP', cleanup);
    process.on('SIGBREAK', cleanup);
}

registerShutdownCleanup(() => {
    closeTauriDriver();
});

export const config = {
    host: '127.0.0.1',
    port: 4444,
    specs: [
        [
            path.join(__dirname, 'test/specs/app-start.e2e.js'),
            path.join(__dirname, 'test/specs/search-smoke.e2e.js'),
            path.join(__dirname, 'test/specs/settings-smoke.e2e.js'),
        ],
    ],
    bail: 1,
    maxInstances: 1,
    waitforTimeout: 15000,
    connectionRetryTimeout: 120000,
    capabilities: [
        {
            maxInstances: 1,
            'tauri:options': {
                application: resolveAppBinaryPath(),
            },
        },
    ],
    reporters: ['spec'],
    framework: 'mocha',
    mochaOpts: {
        ui: 'bdd',
        timeout: 120000,
    },
    onPrepare: () => {
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        fs.mkdirSync(runtimeRoot, { recursive: true });

        const buildResult = spawnSync('pnpm', resolveTauriBuildArgs(), {
            cwd: repoRoot,
            stdio: 'inherit',
            shell: true,
            env: {
                ...process.env,
                CARGO_TARGET_DIR: resolveCargoTargetDirectory(),
                TEMP: resolveTempDirectory(),
                TMP: resolveTempDirectory(),
            },
        });

        if (buildResult.status !== 0) {
            console.error(
                `Failed to build TouchAI debug binary for E2E. Exit code: ${buildResult.status}`
            );
            process.exit(buildResult.status ?? 1);
        }

        assertBuiltAppExists();
    },
    beforeSession: async () => {
        assertBuiltAppExists();

        const tauriDriverPath = resolveTauriDriverPath();
        const nativeDriverPath = resolveNativeDriverPath();

        sessionRuntimePath = path.resolve(runtimeRoot, `session-${Date.now()}`);
        fs.mkdirSync(sessionRuntimePath, { recursive: true });

        const driverArgs = nativeDriverPath ? ['--native-driver', nativeDriverPath] : [];

        tauriDriver = spawn(tauriDriverPath, driverArgs, {
            stdio: [null, process.stdout, process.stderr],
            env: {
                ...process.env,
                CARGO_TARGET_DIR: resolveCargoTargetDirectory(),
                TEMP: resolveTempDirectory(),
                TOUCHAI_APP_ROOT: sessionRuntimePath,
                TOUCHAI_E2E: '1',
                TMP: resolveTempDirectory(),
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

        await waitForDriverServer(4444);
    },
    afterSession: () => {
        closeTauriDriver();
    },
};
