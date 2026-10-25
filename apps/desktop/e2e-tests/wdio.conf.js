import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { provisionFontForAppRoot } from './e2e-font.js';
import { resolveE2eAppBinaryPath, resolveTauriBuildArgs } from './wdio.paths.js';
import { withE2eWebView2Env } from './webview2-env.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const runtimeRoot = path.resolve(repoRoot, '.e2e-runtime');
const visualBaselineRoot = path.resolve(__dirname, '__snapshots__');
const visualRuntimeRoot = path.resolve(runtimeRoot, 'visual');
const updateVisualBaselines = process.env.UPDATE_VISUAL_BASELINE === '1';

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
            path.join(__dirname, 'test/specs/main-window-visual.e2e.js'),
            path.join(__dirname, 'test/specs/search-smoke.e2e.js'),
            path.join(__dirname, 'test/specs/settings-smoke.e2e.js'),
            path.join(__dirname, 'test/specs/prompt-compose.e2e.js'),
            path.join(__dirname, 'test/specs/window-size.e2e.js'),
            path.join(__dirname, 'test/specs/clipboard-paste.e2e.js'),
        ],
    ],
    bail: 1,
    maxInstances: 1,
    waitforTimeout: 15000,
    connectionRetryTimeout: 120000,
    services: [
        [
            'visual',
            {
                baselineFolder: visualBaselineRoot,
                screenshotPath: visualRuntimeRoot,
                autoSaveBaseline: updateVisualBaselines,
                clearRuntimeFolder: true,
                disableCSSAnimation: true,
                disableBlinkingCursor: true,
                hideScrollBars: true,
                waitForFontsLoaded: true,
                alwaysSaveActualImage: false,
                // The CSS layout is pinned by the window sizes the specs set, so the
                // only difference left between machines is the render scale: the
                // app renders at the OS DPI (150% on a laptop, 100% on a CI runner),
                // and WebView2 ignores --force-device-scale-factor. Resizing the
                // actual image to the baseline dimensions removes that difference
                // without touching layout, because both are the same CSS size.
                // Antialiasing is forgiven for the same reason: rescaling re-renders
                // glyph edges, and a font or colour change still moves far more pixels.
                compareOptions: {
                    scaleImagesToSameSize: true,
                    ignoreAntialiasing: true,
                },
                formatImageName: '{tag}',
                savePerInstance: false,
            },
        ],
    ],
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
        // Local visual-regression iteration can reuse the binary from the previous
        // run; CI never sets this, so the checked-in evidence always comes from a
        // fresh build. The default Cargo target lives under `runtimeRoot/tmp`, so
        // clearing the whole directory would delete the binary this branch is meant
        // to reuse.
        if (process.env.TOUCHAI_E2E_SKIP_BUILD === '1') {
            if (fs.existsSync(runtimeRoot)) {
                for (const entry of fs.readdirSync(runtimeRoot)) {
                    if (entry === 'tmp') {
                        continue;
                    }
                    fs.rmSync(path.resolve(runtimeRoot, entry), {
                        recursive: true,
                        force: true,
                    });
                }
            }
            fs.mkdirSync(runtimeRoot, { recursive: true });
            assertBuiltAppExists();
            return;
        }

        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        fs.mkdirSync(runtimeRoot, { recursive: true });

        const buildResult = spawnSync('pnpm', resolveTauriBuildArgs(), {
            cwd: repoRoot,
            stdio: 'inherit',
            shell: true,
            env: withE2eWebView2Env({
                ...process.env,
                CARGO_TARGET_DIR: resolveCargoTargetDirectory(),
                TEMP: resolveTempDirectory(),
                TMP: resolveTempDirectory(),
            }),
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

        // Without the product font the app falls back to a generic serif and every
        // screenshot stops matching what a user sees. Provisioning is verified
        // against the product's own sha256, so a bad download fails the run rather
        // than quietly changing the baselines.
        await provisionFontForAppRoot({
            appRoot: sessionRuntimePath,
            cacheDirectory: path.resolve(resolveCargoTargetDirectory(), 'e2e-font-cache'),
        });

        const driverArgs = nativeDriverPath ? ['--native-driver', nativeDriverPath] : [];
        const webviewUserDataFolder = path.resolve(sessionRuntimePath, 'webview2-user-data');
        fs.mkdirSync(webviewUserDataFolder, { recursive: true });

        // TouchAI.exe must be the application process msedgedriver attaches to.
        // Pass E2E env through tauri-driver so the app inherits TOUCHAI_E2E and
        // applies additionalBrowserArgs in Rust (wry ignores WEBVIEW2_* env alone).
        tauriDriver = spawn(tauriDriverPath, driverArgs, {
            stdio: [null, process.stdout, process.stderr],
            env: withE2eWebView2Env(
                {
                    ...process.env,
                    CARGO_TARGET_DIR: resolveCargoTargetDirectory(),
                    TEMP: resolveTempDirectory(),
                    TOUCHAI_APP_ROOT: sessionRuntimePath,
                    TOUCHAI_E2E: '1',
                    TMP: resolveTempDirectory(),
                },
                { userDataFolder: webviewUserDataFolder }
            ),
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
