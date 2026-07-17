/**
 * WebView2 launch flags for automated desktop E2E.
 *
 * GitHub-hosted Windows runners moved from WebView2 149 (session OK) to 150
 * (session not created: DevToolsActivePort file doesn't exist). Edge/WebView2
 * automation on 150+ needs remote debugging plus the WDP feature flag.
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
