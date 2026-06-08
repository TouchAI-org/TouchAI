import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 30_000;

const TRANSIENT_RELEASE_DOWNLOAD_PATTERNS = [
    /\bhttp status:\s*50[234]\b/i,
    /\bStatus\(50[234]\b/i,
    /\b50[234]\s+Gateway\b/i,
    /\bGateway Time-out\b/i,
    /\bECONNRESET\b/i,
    /\bETIMEDOUT\b/i,
    /\bEAI_AGAIN\b/i,
    /\bconnection timed out\b/i,
    /\bnetwork timeout\b/i,
];

function parsePositiveInteger(value, fallback, label) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }

    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }

    return parsed;
}

function sleep(ms) {
    if (ms <= 0) {
        return Promise.resolve();
    }

    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export function isTransientReleaseDownloadError(output) {
    return TRANSIENT_RELEASE_DOWNLOAD_PATTERNS.some((pattern) => pattern.test(output));
}

export function spawnReleaseCommand(command, args, options = {}) {
    return new Promise((resolve) => {
        let output = '';
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            shell: true,
            stdio: ['inherit', 'pipe', 'pipe'],
        });

        child.stdout.on('data', (chunk) => {
            output += chunk.toString();
            process.stdout.write(chunk);
        });

        child.stderr.on('data', (chunk) => {
            output += chunk.toString();
            process.stderr.write(chunk);
        });

        child.on('error', (error) => {
            output += `${error.message}\n`;
            process.stderr.write(`${error.message}\n`);
            resolve({ status: 1, output });
        });

        child.on('close', (code, signal) => {
            if (typeof code === 'number') {
                resolve({ status: code, output });
                return;
            }

            output += `Command terminated by signal ${signal ?? 'unknown'}.\n`;
            resolve({ status: 1, output });
        });
    });
}

export async function runReleaseCommandWithRetry(command, args, options) {
    const attempts = options.attempts;
    const delayMs = options.delayMs;
    const log = options.log ?? console.warn;
    const spawnCommand =
        options.spawnCommand ??
        ((nextCommand, nextArgs) =>
            spawnReleaseCommand(nextCommand, nextArgs, {
                cwd: options.cwd,
                env: options.env,
            }));

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const result = await spawnCommand(command, args);
        if (result.status === 0) {
            return 0;
        }

        const canRetry = attempt < attempts && isTransientReleaseDownloadError(result.output ?? '');
        if (!canRetry) {
            return result.status;
        }

        log(
            `Release command failed with a transient download error. Retrying attempt ${
                attempt + 1
            }/${attempts} in ${delayMs}ms.`
        );
        await sleep(delayMs);
    }

    return 1;
}

function parseArgs(argv) {
    const separatorIndex = argv.indexOf('--');
    const commandArgs = separatorIndex >= 0 ? argv.slice(separatorIndex + 1) : argv;
    const [command, ...args] = commandArgs;

    if (!command) {
        throw new Error('Usage: node scripts/ci/retry-release-command.mjs -- <command> [...args]');
    }

    return { command, args };
}

async function main() {
    const { command, args } = parseArgs(process.argv.slice(2));
    const status = await runReleaseCommandWithRetry(command, args, {
        attempts: parsePositiveInteger(
            process.env.TOUCHAI_RELEASE_COMMAND_ATTEMPTS,
            DEFAULT_ATTEMPTS,
            'TOUCHAI_RELEASE_COMMAND_ATTEMPTS'
        ),
        delayMs: parsePositiveInteger(
            process.env.TOUCHAI_RELEASE_COMMAND_RETRY_DELAY_MS,
            DEFAULT_DELAY_MS,
            'TOUCHAI_RELEASE_COMMAND_RETRY_DELAY_MS'
        ),
        cwd: process.cwd(),
        env: process.env,
    });

    process.exit(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message ?? error);
        process.exit(1);
    });
}
