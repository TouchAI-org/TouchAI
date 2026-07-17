import fs from 'node:fs';
import path from 'node:path';

/**
 * WebView2 launch flags for automated desktop E2E.
 *
 * GitHub-hosted Windows runners moved from WebView2 149 (session OK) to 150
 * (session not created: DevToolsActivePort file doesn't exist). Edge/WebView2
 * automation on 150+ needs remote debugging plus the WDP feature flag on the
 * host process that creates WebView2.
 */
export const DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [
    '--remote-debugging-port=9222',
    '--enable-features=msEdgeDevToolsWdpRemoteDebugging',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-renderer-backgrounding',
].join(' ');

export function resolveE2eWebView2AdditionalBrowserArguments(env = process.env) {
    const configured = env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS?.trim();
    return configured || DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
}

export function withE2eWebView2Env(env = process.env, options = {}) {
    const next = {
        ...env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: resolveE2eWebView2AdditionalBrowserArguments(env),
    };

    if (options.userDataFolder) {
        next.WEBVIEW2_USER_DATA_FOLDER = options.userDataFolder;
    }

    return next;
}

/**
 * Build a Windows cmd launcher so WEBVIEW2_* vars are set on TouchAI.exe itself.
 * tauri-driver may spawn the application without inheriting the driver process env.
 */
export function createWindowsE2eAppLauncher({
    applicationPath,
    launcherDirectory,
    env = process.env,
    userDataFolder,
}) {
    if (!applicationPath) {
        throw new Error('applicationPath is required');
    }
    if (!launcherDirectory) {
        throw new Error('launcherDirectory is required');
    }

    fs.mkdirSync(launcherDirectory, { recursive: true });
    if (userDataFolder) {
        fs.mkdirSync(userDataFolder, { recursive: true });
    }

    const resolvedEnv = withE2eWebView2Env(env, { userDataFolder });
    const launcherPath = path.resolve(launcherDirectory, 'TouchAI-e2e-launcher.cmd');
    const browserArgs = resolvedEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
    const appRoot = resolvedEnv.TOUCHAI_APP_ROOT;
    const lines = [
        '@echo off',
        'setlocal',
        'set "TOUCHAI_E2E=1"',
        `set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=${browserArgs}"`,
    ];

    if (userDataFolder) {
        lines.push(`set "WEBVIEW2_USER_DATA_FOLDER=${userDataFolder}"`);
    }
    if (appRoot) {
        lines.push(`set "TOUCHAI_APP_ROOT=${appRoot}"`);
    }

    // Use call so %* args from the driver are forwarded and we wait for exit.
    lines.push(`call "${applicationPath}" %*`);
    lines.push('exit /b %ERRORLEVEL%');
    lines.push('');

    fs.writeFileSync(launcherPath, lines.join('\r\n'), 'utf8');
    return launcherPath;
}
