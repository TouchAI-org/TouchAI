import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

type RetryReleaseCommandModule = {
    isTransientReleaseDownloadError: (output: string) => boolean;
    spawnReleaseCommand: (
        command: string,
        args: string[],
        options?: { maxTailBytes?: number }
    ) => Promise<{ status: number; output: string }>;
    runReleaseCommandWithRetry: (
        command: string,
        args: string[],
        options: {
            attempts: number;
            delayMs: number;
            cwd?: string;
            env?: NodeJS.ProcessEnv;
            log?: (message: string) => void;
            spawnCommand: (
                command: string,
                args: string[]
            ) => Promise<{ status: number; output: string }>;
        }
    ) => Promise<number>;
};

async function loadRetryModule(): Promise<RetryReleaseCommandModule | undefined> {
    try {
        const modulePath = join(process.cwd(), 'scripts/ci/retry-release-command.mjs');
        return (await import(pathToFileURL(modulePath).href)) as RetryReleaseCommandModule;
    } catch {
        return undefined;
    }
}

describe('retry release command', () => {
    it('recognizes the GitHub 504 failures seen during release binary downloads', async () => {
        const retryModule = await loadRetryModule();

        expect(retryModule?.isTransientReleaseDownloadError).toBeTypeOf('function');
        expect(
            retryModule?.isTransientReleaseDownloadError(
                'failed to prepare bundled rtk: Status(504, Response[status: 504, status_text: Gateway Time-out])'
            )
        ).toBe(true);
        expect(
            retryModule?.isTransientReleaseDownloadError(
                'failed to bundle project `http status: 504`'
            )
        ).toBe(true);
    });

    it('recognizes the transport and status reasons the bundled download reports', async () => {
        const retryModule = await loadRetryModule();
        const failedDownload = (reason: string) =>
            'failed to prepare bundled rtk: download failed after 3 attempts: ' +
            'https://github.com/rtk-ai/rtk/releases/download/v0.40.0/rtk-x86_64-pc-windows-msvc.zip: ' +
            reason;

        // Each reason below has to match on its own: a fixture that also contains
        // another transient phrase would keep the assertion green after its
        // pattern was deleted.
        expect(
            retryModule?.isTransientReleaseDownloadError(
                failedDownload('tls connection init failed: unexpected eof while reading')
            )
        ).toBe(true);
        expect(
            retryModule?.isTransientReleaseDownloadError(failedDownload('Connection Failed'))
        ).toBe(true);
        expect(retryModule?.isTransientReleaseDownloadError(failedDownload('Network Error'))).toBe(
            true
        );
        expect(retryModule?.isTransientReleaseDownloadError(failedDownload('Dns Failed'))).toBe(
            true
        );
        expect(
            retryModule?.isTransientReleaseDownloadError(
                failedDownload('timed out reading response')
            )
        ).toBe(true);
        expect(
            retryModule?.isTransientReleaseDownloadError(failedDownload('status code 504'))
        ).toBe(true);
    });

    it('does not retry a download that failed verification or does not exist', async () => {
        const retryModule = await loadRetryModule();

        expect(
            retryModule?.isTransientReleaseDownloadError(
                'failed to prepare bundled rtk: digest mismatch for https://example.com/rtk.zip'
            )
        ).toBe(false);
        expect(
            retryModule?.isTransientReleaseDownloadError(
                'failed to prepare bundled rtk: https://example.com/rtk.zip: status code 404'
            )
        ).toBe(false);
    });

    it('retries transient release download failures and returns the successful status', async () => {
        const retryModule = await loadRetryModule();
        const spawnCommand = vi
            .fn()
            .mockResolvedValueOnce({
                status: 1,
                output: 'failed to bundle project `http status: 504`',
            })
            .mockResolvedValueOnce({ status: 0, output: 'release build complete' });

        const status = await retryModule?.runReleaseCommandWithRetry('pnpm', ['tauri', 'build'], {
            attempts: 3,
            delayMs: 0,
            spawnCommand,
        });

        expect(status).toBe(0);
        expect(spawnCommand).toHaveBeenCalledTimes(2);
    });

    it('keeps only a bounded output tail for long command logs', async () => {
        const retryModule = await loadRetryModule();
        const root = await mkdtemp(join(tmpdir(), 'touchai-retry-command-'));
        const scriptPath = join(root, 'long-output.mjs');

        try {
            await writeFile(
                scriptPath,
                [
                    "process.stdout.write('x'.repeat(200));",
                    "process.stderr.write('failed to bundle project http status: 504');",
                    'process.exit(1);',
                ].join('')
            );

            const result = await retryModule?.spawnReleaseCommand('node', [scriptPath], {
                maxTailBytes: 96,
            });

            expect(result?.status).toBe(1);
            expect(result?.output.length).toBeLessThanOrEqual(96);
            expect(result?.output).toContain('http status: 504');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('does not retry non-transient command failures', async () => {
        const retryModule = await loadRetryModule();
        const spawnCommand = vi.fn().mockResolvedValue({
            status: 1,
            output: 'error[E0425]: cannot find function `resize_search_window` in this scope',
        });

        const status = await retryModule?.runReleaseCommandWithRetry('pnpm', ['tauri', 'build'], {
            attempts: 3,
            delayMs: 0,
            spawnCommand,
        });

        expect(status).toBe(1);
        expect(spawnCommand).toHaveBeenCalledTimes(1);
    });

    it('user gets an argument with quotes and spaces passed through unchanged when the release wrapper spawns a command', async () => {
        const retryModule = await loadRetryModule();
        const root = await mkdtemp(join(tmpdir(), 'touchai-retry-command-'));
        const scriptPath = join(root, 'echo-argument.mjs');
        const argument = JSON.stringify({
            version: '1.2.3',
            bundle: { linux: { rpm: { release: '0.beta.1' } } },
        });

        try {
            await writeFile(scriptPath, 'process.stdout.write(process.argv[2] ?? "");');

            const result = await retryModule?.spawnReleaseCommand('node', [scriptPath, argument]);

            expect(result?.status).toBe(0);
            expect(result?.output).toBe(argument);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
