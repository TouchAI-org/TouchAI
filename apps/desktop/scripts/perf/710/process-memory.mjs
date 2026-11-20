import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_INTERVAL_MS = 250;
const INCLUDED_PROCESS = /^(TouchAI|WebKit(?!WebDriver$)(Web|Network|Storage|GPU|Cache).*)$/;

function readArgs() {
    const args = process.argv.slice(2);
    const value = (name) => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : undefined;
    };
    return {
        appRoot: path.resolve(value('--app-root') ?? ''),
        out: path.resolve(value('--out') ?? ''),
        intervalMs: Number(value('--interval-ms')) || DEFAULT_INTERVAL_MS,
        runId: value('--run-id') ?? '',
        arm: value('--arm') ?? '',
        flow: value('--flow') ?? '',
        runToken: value('--run-token') ?? '',
    };
}

function processEnvironment(pid) {
    try {
        return fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0').filter(Boolean);
    } catch {
        return [];
    }
}

function processName(pid) {
    try {
        return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    } catch {
        return '';
    }
}

function processParent(pid) {
    try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        return Number(status.match(/^PPid:\s+(\d+)$/m)?.[1] ?? 0);
    } catch {
        return 0;
    }
}

function processCgroup(pid) {
    try {
        const text = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim();
        return text.split('\n').at(-1)?.split(':').slice(2).join(':') ?? '';
    } catch {
        return '';
    }
}

export function readRollup(pid) {
    try {
        const text = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
        const readKb = (key) => {
            const raw = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm'))?.[1];
            return raw === undefined ? null : Number(raw);
        };
        return {
            pssKb: readKb('Pss'),
            rssKb: readKb('Rss'),
            privateDirtyKb: readKb('Private_Dirty'),
        };
    } catch {
        try {
            const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
            const rss = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1];
            return {
                pssKb: null,
                rssKb: rss === undefined ? null : Number(rss),
                privateDirtyKb: null,
            };
        } catch {
            return null;
        }
    }
}

export function aggregateMemory(processes) {
    const total = (key) => {
        const values = processes.map((item) => item[key]);
        if (
            values.length === 0 ||
            values.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ) {
            return null;
        }
        return values.reduce((sum, value) => sum + value, 0);
    };
    return {
        totalPssKb: total('pssKb'),
        totalRssKb: total('rssKb'),
        totalPrivateDirtyKb: total('privateDirtyKb'),
    };
}

export function processBelongsToRun(
    candidate,
    { appPids, appCgroups, environmentMarker, runTokenMarker }
) {
    if (appPids.has(candidate.pid)) return true;
    const hasRunIdentity =
        candidate.environment.includes(environmentMarker) ||
        (runTokenMarker && candidate.environment.includes(runTokenMarker));
    if (!hasRunIdentity) return false;
    if (!candidate.cgroup || appCgroups.size === 0) return true;
    return appCgroups.has(candidate.cgroup);
}

function processesForRoot(appRoot, runToken) {
    const marker = `TOUCHAI_APP_ROOT=${appRoot}`;
    const tokenMarker = runToken ? `TOUCHAI_PERF_RUN_TOKEN=${runToken}` : '';
    const candidates = [];

    for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        const pid = Number(entry.name);
        if (pid === process.pid) continue;
        const name = processName(pid);
        if (!INCLUDED_PROCESS.test(name)) continue;
        const environment = processEnvironment(pid);
        candidates.push({
            pid,
            name,
            environment,
            parent: processParent(pid),
            cgroup: processCgroup(pid),
        });
    }

    const appProcesses = candidates.filter(
        (candidate) =>
            candidate.name === 'TouchAI' &&
            (candidate.environment.includes(marker) ||
                (tokenMarker && candidate.environment.includes(tokenMarker)))
    );
    const appPids = new Set(appProcesses.map((candidate) => candidate.pid));
    const appCgroups = new Set(appProcesses.map((candidate) => candidate.cgroup).filter(Boolean));
    const result = [];

    for (const candidate of candidates) {
        if (
            !processBelongsToRun(candidate, {
                appPids,
                appCgroups,
                environmentMarker: marker,
                runTokenMarker: tokenMarker,
            })
        ) {
            continue;
        }
        const memory = readRollup(candidate.pid);
        if (!memory) continue;
        result.push({ pid: candidate.pid, name: candidate.name, ...memory });
    }
    return result.sort((left, right) => left.pid - right.pid);
}

function main() {
    const args = readArgs();
    if (!args.appRoot || !args.out) {
        throw new Error(
            'Usage: process-memory.mjs --app-root <path> --out <jsonl> [--run-token <token>]'
        );
    }

    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    let running = true;
    let timer = null;
    fs.appendFileSync(
        args.out,
        `${JSON.stringify({
            type: 'sampler-start',
            at: Date.now(),
            runId: args.runId,
            arm: args.arm,
            flow: args.flow,
            appRoot: args.appRoot,
            runToken: args.runToken,
        })}\n`
    );

    const stop = () => {
        running = false;
        if (timer) clearTimeout(timer);
    };

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);

    const sample = () => {
        if (!running) return;
        const processes = processesForRoot(args.appRoot, args.runToken);
        const record = {
            type: 'memory',
            at: Date.now(),
            runId: args.runId,
            arm: args.arm,
            flow: args.flow,
            appRoot: args.appRoot,
            processes,
            ...aggregateMemory(processes),
        };
        fs.appendFileSync(args.out, `${JSON.stringify(record)}\n`);
        timer = setTimeout(sample, args.intervalMs);
    };

    sample();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
