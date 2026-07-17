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
        '        var startInfo = new ProcessStartInfo',
        '        {',
        '            FileName = ' + appLiteral + ',',
        '            UseShellExecute = false,',
        '        };',
        '        foreach (var arg in args)',
        '        {',
        '            startInfo.ArgumentList.Add(arg);',
        '        }',
        '        using (var process = Process.Start(startInfo))',
        '        {',
        '            if (process == null)',
        '            {',
        '                Console.Error.WriteLine("Failed to start TouchAI for E2E.");',
        '                return 1;',
        '            }',
        '            process.WaitForExit();',
        '            return process.ExitCode;',
        '        }',
        '    }',
        '}',
        ''
    );

    return lines.join('\n');
}

/**
 * Build a Windows .exe launcher so WEBVIEW2_* vars are set on TouchAI.exe itself.
 * msedgedriver rejects non-exe application paths.
 */
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

    const compileResult = spawnSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-Command',
            [
                '$source = Get-Content -LiteralPath $env:TOUCHAI_E2E_LAUNCHER_SOURCE -Raw;',
                'Add-Type -TypeDefinition $source -OutputAssembly $env:TOUCHAI_E2E_LAUNCHER_EXE -OutputType ConsoleApplication;',
                "if (-not (Test-Path -LiteralPath $env:TOUCHAI_E2E_LAUNCHER_EXE)) { throw 'launcher exe was not created' }",
            ].join(' '),
        ],
        {
            encoding: 'utf8',
            env: {
                ...process.env,
                TOUCHAI_E2E_LAUNCHER_SOURCE: launcherSourcePath,
                TOUCHAI_E2E_LAUNCHER_EXE: launcherExePath,
            },
        }
    );

    if (compileResult.status !== 0) {
        throw new Error(
            [
                'Failed to compile TouchAI E2E Windows launcher.',
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
