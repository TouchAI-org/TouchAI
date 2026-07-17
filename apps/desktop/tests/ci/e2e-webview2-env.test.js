import { describe, expect, it } from 'vitest';

import {
    DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
    resolveE2eWebView2AdditionalBrowserArguments,
    withE2eWebView2Env,
} from '../../e2e-tests/webview2-env.js';

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

        expect(withE2eWebView2Env(env, { userDataFolder: 'D:\e2e-user-data' })).toEqual({
            TOUCHAI_E2E: '1',
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
                DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
            WEBVIEW2_USER_DATA_FOLDER: 'D:\e2e-user-data',
        });
    });
});
