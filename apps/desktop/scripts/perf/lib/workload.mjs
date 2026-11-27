export const MAX_RAIL_TICKS = 96;

export function railTickCount(turns, policy) {
    if (!Number.isInteger(turns) || turns < 0) throw new Error('Invalid rail turn count.');
    if (policy === 'all') return turns;
    if (policy === 'sampled') return Math.min(turns, MAX_RAIL_TICKS);
    throw new Error(`Unknown rail policy: ${policy}`);
}

export function workloadFor(flow) {
    if (flow === 'latency') {
        return { rounds: 12, chunks: 24, chunkBytes: 32, alternate: false, chunkDelayMs: 8 };
    }
    if (flow === 'progress') {
        return { rounds: 24, chunks: 128, chunkBytes: 1024, alternate: true, chunkDelayMs: 1 };
    }
    if (flow === 'long-session') {
        return { rounds: 2, chunks: 32, chunkBytes: 256, alternate: false, chunkDelayMs: 8 };
    }
    throw new Error(`Unknown performance flow: ${flow}`);
}
