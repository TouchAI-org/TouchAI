/**
 * WebView2 launch flags for automated desktop E2E.
 *
 * WebView2 / Edge 150+ on GitHub-hosted Windows runners fails tauri-driver session
 * creation with "DevToolsActivePort file doesn't exist" unless remote debugging is
 * explicitly enabled. Keep overrides optional so local debugging can still customize.
 */
export const DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = [
    '--remote-debugging-port=0',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
].join(' ');

export function resolveE2eWebView2AdditionalBrowserArguments(env = process.env) {
    const configured = env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS?.trim();
    return configured || DEFAULT_E2E_WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS;
}

export function withE2eWebView2Env(env = process.env) {
    return {
        ...env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
            resolveE2eWebView2AdditionalBrowserArguments(env),
    };
}
