import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
    ensureDirectory(path.dirname(options.log));
    const descriptor = fs.openSync(options.log, 'a');
    const startedAt = Date.now();
    appendLog(
        options.log,
        `\n$ ${commandLine(command, args)}\ncwd=${options.cwd ?? repoRoot}\nat=${nowIso()}\n`
    );

    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd ?? repoRoot,
            env: options.env ?? process.env,
            stdio: ['ignore', descriptor, descriptor],
        });
        child.once('error', (error) => {
            fs.closeSync(descriptor);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            const result = {
                command: commandLine(command, args),
                cwd: options.cwd ?? repoRoot,
                exitCode: code,
                signal,
                elapsedMs: Date.now() - startedAt,
            };
            appendLog(
                options.log,
                `exit=${code} signal=${signal ?? ''} elapsed_ms=${result.elapsedMs}\n`
            );
            fs.closeSync(descriptor);
            resolve(result);
        });
    });
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
    });
    systemdRunAvailable = probe.status === 0;
    if (!systemdRunAvailable) {
        console.warn('systemd-run --user is unavailable; running without a transient cgroup.');
    }
    return systemdRunAvailable;
}

export async function runInCgroup({ label, command, args, cwd, env, log }) {
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
    });
    return {
        ...result,
        unit: useSystemd ? unit : null,
        cgroup: parseMetricsFile(metricsFile),
        log,
    };
}
