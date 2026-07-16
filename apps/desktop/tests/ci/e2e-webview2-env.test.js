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
            '--remote-debugging-port=0'
        );
        expect(DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS).toContain('--no-sandbox');
    });

    it('preserves an explicit WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS override', () => {
        const env = {
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
            TOUCHAI_E2E: '1',
        };

        expect(resolveE2eWebView2AdditionalBrowserArguments(env)).toBe(
            '--remote-debugging-port=9222'
        );
        expect(withE2eWebView2Env(env)).toEqual({
            ...env,
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
        });
    });

    it('injects default browser arguments when the env var is absent', () => {
        const env = { TOUCHAI_E2E: '1' };

        expect(withE2eWebView2Env(env)).toEqual({
            TOUCHAI_E2E: '1',
            WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
                DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
        });
    });
});
