import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class PerformanceHarnessLockedError extends Error {
    constructor(lockPath) {
        super(
            `Another performance harness command already owns ${lockPath}. ` +
                'Wait for it to finish or remove the lock if its process is no longer running.'
        );
        this.name = 'PerformanceHarnessLockedError';
        this.code = 'PERF_HARNESS_LOCKED';
        this.lockPath = lockPath;
    }
}

export function performanceHarnessLockPath(root) {
    const digest = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
    return path.join(os.tmpdir(), `touchai-perf-${digest}.lock`);
}

export function performanceHarnessLockPaths(evidenceRoot, artifactsRoot) {
    return [...new Set([path.resolve(evidenceRoot), path.resolve(artifactsRoot)])]
        .sort()
        .map(performanceHarnessLockPath);
}

function acquireFileLock(lockPath, metadata) {
    const token = randomUUID();
    let descriptor;
    try {
        descriptor = fs.openSync(lockPath, 'wx');
    } catch (error) {
        if (error && typeof error === 'object' && error.code === 'EEXIST') {
            throw new PerformanceHarnessLockedError(lockPath);
        }
        throw error;
    }
    try {
        fs.writeFileSync(
            descriptor,
            `${JSON.stringify({ ...metadata, pid: process.pid, startedAt: new Date().toISOString(), token })}\n`
        );
    } catch (error) {
        fs.closeSync(descriptor);
        fs.rmSync(lockPath, { force: true });
        throw error;
    }
    fs.closeSync(descriptor);
    return {
        path: lockPath,
        token,
        release() {
            try {
                const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
                if (owner.token !== token) return;
                fs.rmSync(lockPath, { force: true });
            } catch (error) {
                if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
            }
        },
    };
}

export function acquirePerformanceHarnessLock({ command, evidenceRoot, artifactsRoot }) {
    const acquired = [];
    try {
        for (const lockPath of performanceHarnessLockPaths(evidenceRoot, artifactsRoot)) {
            acquired.push(acquireFileLock(lockPath, { command }));
        }
    } catch (error) {
        for (const lock of acquired.reverse()) lock.release();
        throw error;
    }
    return {
        paths: acquired.map((lock) => lock.path),
        release() {
            for (const lock of acquired.reverse()) lock.release();
        },
    };
}
