import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

export const perfRoot = path.resolve(scriptDir, '..');
export const repoRoot = path.resolve(scriptDir, '../../../../..');
export const evidenceRoot = path.resolve(
    process.env.TOUCHAI_PERF_EVIDENCE ?? path.join(os.tmpdir(), 'touchai-perf-evidence')
);
export const artifactsRoot = path.resolve(
    process.env.TOUCHAI_PERF_ARTIFACTS ?? path.join(os.tmpdir(), 'touchai-perf-artifacts')
);
export const snapshotsRoot = path.join(artifactsRoot, 'snapshots');
export const buildTarget = path.join(artifactsRoot, 'target');
export const runtimeRoot = path.join(artifactsRoot, 'runtime');
export const logsRoot = path.join(evidenceRoot, 'logs');
export const rawRoot = path.join(evidenceRoot, 'raw', 'formal');
export const fixturesRoot = path.join(evidenceRoot, 'fixtures');
export const manifestsRoot = path.join(evidenceRoot, 'manifests');
export const binariesRoot = path.join(evidenceRoot, 'binaries');
export const cgroupExec = path.join(perfRoot, 'cgroup-exec.sh');
export const memorySampler = path.join(perfRoot, 'process-memory.mjs');
export const xvfbRunWithWm = path.join(perfRoot, 'xvfb-run-with-wm.sh');
export const desktopRoot = path.join(repoRoot, 'apps/desktop');
export const wdioConfigRoot = path.join(desktopRoot, 'e2e-tests');
export const wdioBinary = path.join(desktopRoot, 'node_modules/.bin/wdio');
export const currentSnapshot = path.join(snapshotsRoot, 'current');
export const baselineSnapshot = path.join(snapshotsRoot, 'baseline');

export const MANIFEST_VERSION = 1;
export const MAX_DISPLAY_STARTUP_ATTEMPTS = 2;
export const DEFAULT_PORT = readPort(process.env.TOUCHAI_PERF_PORT ?? 3426);
export const startupSettleMs = readPositiveInteger(
    process.env.TOUCHAI_PERF_STARTUP_SETTLE_MS ?? 8000,
    'TOUCHAI_PERF_STARTUP_SETTLE_MS'
);

export const arms = ['baseline', 'current'];
export const armOrder = ['baseline', 'current', 'current', 'baseline'];
export const binaryPathByArm = {
    baseline: path.join(binariesRoot, 'baseline', 'TouchAI'),
    current: path.join(binariesRoot, 'current', 'TouchAI'),
};

export const fixtureLevels = [100, 500, 1000, 1500];
export const fixtureNames = ['base', ...fixtureLevels.map((level) => `long-${level}`)];
export const fixturePathByArm = Object.fromEntries(
    ['baseline', 'current'].map((arm) => [
        arm,
        Object.fromEntries(
            fixtureNames.map((name) => [
                name,
                path.join(
                    fixturesRoot,
                    arm,
                    name === 'base' ? 'fixture-base.db' : `fixture-${name}.db`
                ),
            ])
        ),
    ])
);

function readPort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error(`Invalid performance model port: ${value}`);
    }
    return port;
}

function readPositiveInteger(value, name) {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return number;
}
