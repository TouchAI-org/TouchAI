import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class PerformanceHarnessLockedError extends Error {
    constructor(lockPath) {
        super(
            `Another performance harness command already owns ${lockPath}. ` +
                'Wait for it to finish. Remove a stale lock only after its owner and all workload descendants have stopped.'
        );
        this.name = 'PerformanceHarnessLockedError';
        this.code = 'PERF_HARNESS_LOCKED';
        this.lockPath = lockPath;
    }
}

export function performanceHarnessLockPath(root) {
    function canonical(file) {
        try {
            return fs.realpathSync(file);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return path.join(canonical(path.dirname(file)), path.basename(file));
        }
    }
    const resource = canonical(path.resolve(root));
    // A sibling survives resource cleanup and has one identity across TMPDIRs.
    return path.join(path.dirname(resource), `.${path.basename(resource)}.touchai-perf.lock`);
}

export function performanceHarnessLockPaths(evidenceRoot, artifactsRoot) {
    return [...new Set([evidenceRoot, artifactsRoot].map(performanceHarnessLockPath))].sort();
}

function acquireFileLock(lockPath, metadata) {
    const token = randomUUID();
    let descriptor;
    try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
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
