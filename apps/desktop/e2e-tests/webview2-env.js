import { spawnSync } from 'node:child_process';
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

function csharpStringLiteral(value) {
    return JSON.stringify(String(value));
}

/**
 * Generate C# source for a tiny Windows host that sets WEBVIEW2_* then launches TouchAI.exe.
 * tauri-driver / msedgedriver require an .exe application path (not .cmd).
 */
export function buildWindowsE2eLauncherSource({
    applicationPath,
    browserArguments,
    userDataFolder,
    appRoot,
}) {
    const appLiteral = csharpStringLiteral(applicationPath);
    const argsLiteral = csharpStringLiteral(browserArguments);
    const lines = [
        'using System;',
        'using System.Diagnostics;',
        'using System.Text;',
        '',
        'public static class TouchAIE2ELauncher',
        '{',
        '    public static int Main(string[] args)',
        '    {',
        '        Environment.SetEnvironmentVariable("TOUCHAI_E2E", "1");',
        '        Environment.SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", ' +
            argsLiteral +
            ');',
    ];

    if (userDataFolder) {
        lines.push(
            '        Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", ' +
                csharpStringLiteral(userDataFolder) +
                ');'
        );
    }
    if (appRoot) {
        lines.push(
            '        Environment.SetEnvironmentVariable("TOUCHAI_APP_ROOT", ' +
                csharpStringLiteral(appRoot) +
                ');'
        );
    }

    lines.push(
        '        var argumentBuilder = new StringBuilder();',
        '        for (var index = 0; index < args.Length; index++)',
        '        {',
        '            if (index > 0)',
        '            {',
        "                argumentBuilder.Append(' ');",
        '            }',
        '            var value = args[index] ?? string.Empty;',
        "            if (value.IndexOfAny(new char[] { ' ', '\"' }) >= 0)",
        '            {',
        "                argumentBuilder.Append('\"');",
        '                argumentBuilder.Append(value.Replace("\\"", "\\\\\\""));',
        "                argumentBuilder.Append('\"');",
        '            }',
        '            else',
        '            {',
        '                argumentBuilder.Append(value);',
        '            }',
        '        }',
        '        var startInfo = new ProcessStartInfo();',
        '        startInfo.FileName = ' + appLiteral + ';',
        '        startInfo.Arguments = argumentBuilder.ToString();',
        '        startInfo.UseShellExecute = false;',
        '        var process = Process.Start(startInfo);',
        '        if (process == null)',
        '        {',
        '            Console.Error.WriteLine("Failed to start TouchAI for E2E.");',
        '            return 1;',
        '        }',
        '        process.WaitForExit();',
        '        return process.ExitCode;',
        '    }',
        '}',
        ''
    );

    return lines.join('\n');
}

function resolveCscPath() {
    const windir = process.env.WINDIR || 'C:\\Windows';
    const candidates = [
        path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
        path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

export function createWindowsE2eAppLauncher({
    applicationPath,
    launcherDirectory,
    env = process.env,
    userDataFolder,
    compile = process.platform === 'win32',
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
    const launcherExePath = path.resolve(launcherDirectory, 'TouchAI-e2e-launcher.exe');
    const launcherSourcePath = path.resolve(launcherDirectory, 'TouchAI-e2e-launcher.cs');
    const source = buildWindowsE2eLauncherSource({
        applicationPath,
        browserArguments: resolvedEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
        userDataFolder,
        appRoot: resolvedEnv.TOUCHAI_APP_ROOT,
    });

    fs.writeFileSync(launcherSourcePath, source, 'utf8');

    if (!compile) {
        return launcherSourcePath;
    }

    const cscPath = resolveCscPath();
    if (!cscPath) {
        throw new Error(
            'csc.exe was not found under %WINDIR%\\Microsoft.NET\\Framework*\\v4.0.30319'
        );
    }

    const compileResult = spawnSync(
        cscPath,
        ['/nologo', '/target:exe', `/out:${launcherExePath}`, launcherSourcePath],
        {
            encoding: 'utf8',
        }
    );

    if (compileResult.status !== 0) {
        throw new Error(
            [
                'Failed to compile TouchAI E2E Windows launcher with csc.exe.',
                compileResult.stdout,
                compileResult.stderr,
            ]
                .filter(Boolean)
                .join('\n')
        );
    }

    if (!fs.existsSync(launcherExePath)) {
        throw new Error(`E2E launcher exe was not produced at ${launcherExePath}`);
    }

    return launcherExePath;
}
