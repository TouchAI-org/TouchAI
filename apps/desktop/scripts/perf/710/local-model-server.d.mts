import type { Server } from 'node:http';

export type PerfModelServerOptions = {
    port?: number;
    chunkDelayMs?: number;
    logFile?: string | null;
};

export type PerfModelServer = {
    server: Server;
    port: number;
    close: () => Promise<void>;
};

export function startPerfModelServer(options?: PerfModelServerOptions): Promise<PerfModelServer>;
