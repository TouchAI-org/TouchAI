import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

type RetryReleaseCommandModule = {
    isTransientReleaseDownloadError: (output: string) => boolean;
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
});
