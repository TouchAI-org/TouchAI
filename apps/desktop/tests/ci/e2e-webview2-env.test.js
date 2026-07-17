import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    buildWindowsE2eLauncherSource,
    createWindowsE2eAppLauncher,
    DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    resolveE2eWebView2AdditionalBrowserArguments,
    withE2eWebView2Env,
} from '../../e2e-tests/webview2-env.js';

const tempRoots = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('E2E WebView2 launch environment', () => {
    it('defaults to remote-debugging flags that keep DevToolsActivePort available', () => {
        expect(resolveE2eWebView2AdditionalBrowserArguments({})).toBe(
            DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
        );
        expect(DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toContain(
            '--remote-debugging-port=9222'
        );
        expect(DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toContain(
            'msEdgeDevToolsWdpRemoteDebugging'
        );
        expect(DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toContain('--no-sandbox');
    });

    it('preserves an explicit WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS override', () => {
        const env = {
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333',
            TOUCHAI_E2E: '1',
        };

        expect(resolveE2eWebView2AdditionalBrowserArguments(env)).toBe(
            '--remote-debugging-port=9333'
        );
        expect(withE2eWebView2Env(env)).toEqual({
            ...env,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9333',
        });
    });

    it('injects default browser arguments and optional user data folder', () => {
        const env = { TOUCHAI_E2E: '1' };

        expect(withE2eWebView2Env(env)).toEqual({
            TOUCHAI_E2E: '1',
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
                DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
        });

        expect(withE2eWebView2Env(env, { userDataFolder: 'D:/e2e-user-data' })).toEqual({
            TOUCHAI_E2E: '1',
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
                DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
            WEBVIEW2_USER_DATA_FOLDER: 'D:/e2e-user-data',
        });
    });

    it('generates C# launcher source that sets WebView2 env and starts TouchAI.exe', () => {
        const source = buildWindowsE2eLauncherSource({
            applicationPath: 'D:/app/TouchAI.exe',
            browserArguments: DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
            userDataFolder: 'D:/app/webview2-user-data',
            appRoot: 'D:/app/root',
        });

        expect(source).toContain('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS');
        expect(source).toContain('--remote-debugging-port=9222');
        expect(source).toContain('D:/app/TouchAI.exe');
        expect(source).toContain('WEBVIEW2_USER_DATA_FOLDER');
        expect(source).toContain('TOUCHAI_APP_ROOT');
        expect(source).toContain('Process.Start');
    });

    it('writes launcher source without compiling when compile is disabled', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-e2e-launcher-'));
        tempRoots.push(root);

        const applicationPath = path.join(root, 'TouchAI.exe');
        fs.writeFileSync(applicationPath, '');
        const launcherDirectory = path.join(root, 'launcher');
        const userDataFolder = path.join(root, 'webview2-user-data');

        const launcherPath = createWindowsE2eAppLauncher({
            applicationPath,
            launcherDirectory,
            userDataFolder,
            env: { TOUCHAI_APP_ROOT: path.join(root, 'app-root') },
            compile: false,
        });

        expect(launcherPath.endsWith('TouchAI-e2e-launcher.cs')).toBe(true);
        const content = fs.readFileSync(launcherPath, 'utf8');
        expect(content).toContain('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS');
        expect(content).toContain('--remote-debugging-port=9222');
        expect(content).toContain('Process.Start');
        expect(content).toContain('.exe');
    });
});
