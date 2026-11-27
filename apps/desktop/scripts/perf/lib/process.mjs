import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { cgroupExec, repoRoot } from './config.mjs';
import { appendLog, ensureDirectory, nowIso } from './io.mjs';

function commandLine(command, args) {
    return [command, ...args]
        .map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part)))
        .join(' ');
}

export function runSync(command, args, options = {}) {
    const startedAt = Date.now();
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repoRoot,
        env: options.env ?? process.env,
        encoding: options.encoding ?? 'utf8',
        input: options.input,
        maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
        timeout: options.timeout ?? 120000,
    });
    const record = {
        command: commandLine(command, args),
        cwd: options.cwd ?? repoRoot,
        exitCode: result.status,
        signal: result.signal,
        elapsedMs: Date.now() - startedAt,
        at: nowIso(),
    };
    if (options.log) {
        appendLog(
            options.log,
            [
                `\n$ ${record.command}`,
                `cwd=${record.cwd}`,
                `exit=${record.exitCode} signal=${record.signal ?? ''} elapsed_ms=${record.elapsedMs}`,
                result.stdout ? `--- stdout ---\n${result.stdout}` : '',
                result.stderr ? `--- stderr ---\n${result.stderr}` : '',
                '',
            ].join('\n')
        );
    }
    if (result.error) throw result.error;
    if (result.status !== 0 && !options.allowFailure) {
        throw new Error(
            `${record.command} failed with exit ${result.status}: ${String(result.stderr).trim()}`
        );
    }
    return { ...record, stdout: result.stdout, stderr: result.stderr };
}

async function runStreaming(command, args, options = {}) {
    options.signal?.throwIfAborted();
    ensureDirectory(path.dirname(options.log));
    const descriptor = fs.openSync(options.log, 'a');
    const startedAt = Date.now();
    appendLog(
        options.log,
        `\n$ ${commandLine(command, args)}\ncwd=${options.cwd ?? repoRoot}\nat=${nowIso()}\n`
    );

    try {
        return await new Promise((resolve, reject) => {
            const child = spawn(command, args, {
                cwd: options.cwd ?? repoRoot,
                env: options.env ?? process.env,
                stdio: ['ignore', descriptor, descriptor],
                detached: process.platform !== 'win32',
            });
            let cancellation;
            let failure;
            const cancel = () => {
                cancellation ??= terminateWorkload(child, options.unit).catch((error) => {
                    failure = new Error(
                        'Cannot confirm performance workload cleanup; preserve its lock.',
                        {
                            cause: error,
                        }
                    );
                    failure.code = 'PERF_CLEANUP_FAILED';
                    // Do not wait indefinitely for `close` after bounded cleanup failed.
                    options.signal?.removeEventListener('abort', cancel);
                    child.unref();
                    reject(failure);
                });
            };
            options.signal?.addEventListener('abort', cancel, { once: true });
            if (options.signal?.aborted) cancel();
            child.once('error', (error) => {
                failure = error;
            });
            child.once('close', async (code, signal) => {
                await cancellation;
                options.signal?.removeEventListener('abort', cancel);
                if (failure) {
                    reject(failure);
                    return;
                }
                const result = {
                    command: commandLine(command, args),
                    cwd: options.cwd ?? repoRoot,
                    exitCode: code,
                    signal: options.signal?.aborted ? 'SIGTERM' : signal,
                    elapsedMs: Date.now() - startedAt,
                };
                try {
                    appendLog(
                        options.log,
                        `exit=${code} signal=${result.signal ?? ''} elapsed_ms=${result.elapsedMs}\n`
                    );
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
        });
    } finally {
        fs.closeSync(descriptor);
    }
}

function processTable(unit) {
    if (process.platform !== 'linux') return [];
    return fs
        .readdirSync('/proc')
        .filter((pid) => /^\d+$/.test(pid))
        .flatMap((pid) => {
            try {
                const fields = fs
                    .readFileSync(`/proc/${pid}/stat`, 'utf8')
                    .split(') ')
                    .at(-1)
                    .split(' ');
                return [
                    {
                        pid: Number(pid),
                        parent: Number(fields[1]),
                        group: Number(fields[2]),
                        start: fields[19],
                        state: fields[0],
                        inScope:
                            Boolean(unit) &&
                            fs
                                .readFileSync(`/proc/${pid}/cgroup`, 'utf8')
                                .split('\n')
                                .some((line) => line.endsWith(`/${unit}.scope`)),
                    },
                ];
            } catch (error) {
                if (['ENOENT', 'ESRCH'].includes(error.code)) return [];
                throw error;
            }
        });
}

async function terminateWorkload(child, unit) {
    if (!child.pid) return;
    const known = new Map();
    const discover = () => {
        const table = processTable(unit);
        const byPid = new Map(table.map((entry) => [entry.pid, entry]));
        let added;
        do {
            added = false;
            for (const entry of table) {
                if (
                    entry.pid === child.pid ||
                    entry.group === child.pid ||
                    entry.inScope ||
                    (known.has(entry.parent) &&
                        known.get(entry.parent) === byPid.get(entry.parent)?.start)
                ) {
                    if (!known.has(entry.pid)) {
                        known.set(entry.pid, entry.start);
                        added = true;
                    }
                }
            }
        } while (added);
        return table.filter((entry) => known.get(entry.pid) === entry.start && entry.state !== 'Z');
    };
    const send = (signal) => {
        const members = discover();
        if (unit) {
            // The scope also owns descendants which create another session/group.
            const result = spawnSync(
                'systemctl',
                ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, `${unit}.scope`],
                { timeout: 2000, stdio: 'ignore' }
            );
            if (result.error || result.status !== 0) {
                console.warn(
                    `Cannot signal ${unit}.scope with systemctl; killing and verifying its process members directly.`
                );
            }
        }
        try {
            if (process.platform === 'win32') child.kill(signal);
            else process.kill(-child.pid, signal);
        } catch (error) {
            if (error.code !== 'ESRCH') throw error;
        }
        for (const member of members) {
            try {
                process.kill(member.pid, signal);
            } catch (error) {
                if (error.code !== 'ESRCH') throw error;
            }
        }
    };
    send('SIGTERM');
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && discover().length) await delay(25);
    if (!discover().length) return;
    send('SIGKILL');
    const killDeadline = Date.now() + 3000;
    while (Date.now() < killDeadline && discover().length) await delay(25);
    if (discover().length) {
        const error = new Error(
            'Performance workload cleanup failed; preserve its lock until all descendants exit.'
        );
        error.code = 'PERF_CLEANUP_FAILED';
        throw error;
    }
}

function parseMetricsFile(file) {
    if (!fs.existsSync(file)) return {};
    const metrics = {};
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
        if (!line) continue;
        const [key, value] = line.trim().split(/[=\s]+/, 2);
        metrics[key] = value;
    }
    return metrics;
}

let systemdRunAvailable;

function canUseSystemdRun() {
    if (process.env.TOUCHAI_PERF_DISABLE_CGROUP === '1') return false;
    if (systemdRunAvailable !== undefined) return systemdRunAvailable;
    const probe = spawnSync('systemd-run', ['--user', '--scope', '--collect', '--quiet', 'true'], {
        stdio: 'ignore',
        timeout: 5000,
    });
    systemdRunAvailable = probe.status === 0;
    if (!systemdRunAvailable) {
        console.warn('systemd-run --user is unavailable; running without a transient cgroup.');
    }
    return systemdRunAvailable;
}

export async function runInCgroup({ label, command, args, cwd, env, log, signal }) {
    if (process.platform !== 'linux')
        throw new Error('Native performance measurement requires Linux.');
    signal?.throwIfAborted();
    const unit = `touchai-perf-${label}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-');
    const metricsFile = `${log}.cgroup`;
    fs.rmSync(metricsFile, { force: true });
    const directCommand = ['bash', cgroupExec, command, ...args];
    const useSystemd = canUseSystemdRun();
    const executable = useSystemd ? 'systemd-run' : directCommand[0];
    const executableArgs = useSystemd
        ? [
              '--user',
              '--scope',
              '--collect',
              `--unit=${unit}`,
              '-p',
              'MemoryAccounting=yes',
              '-p',
              `MemoryHigh=${process.env.TOUCHAI_PERF_MEMORY_HIGH ?? '1700M'}`,
              '-p',
              `MemoryMax=${process.env.TOUCHAI_PERF_MEMORY_MAX ?? '2200M'}`,
              '-p',
              `MemorySwapMax=${process.env.TOUCHAI_PERF_MEMORY_SWAP_MAX ?? '2000M'}`,
              '-p',
              `CPUQuota=${process.env.TOUCHAI_PERF_CPU_QUOTA ?? '150%'}`,
              '--nice=10',
              '--',
              ...directCommand,
          ]
        : directCommand.slice(1);
    const result = await runStreaming(executable, executableArgs, {
        cwd,
        env: {
            ...env,
            TOUCHAI_PERF_CGROUP_METRICS: metricsFile,
        },
        log,
        signal,
        unit: useSystemd ? unit : null,
    });
    return {
        ...result,
        unit: useSystemd ? unit : null,
        cgroup: parseMetricsFile(metricsFile),
        log,
    };
}
