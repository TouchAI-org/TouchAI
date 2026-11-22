export type PerfModelServerOptions = {
    port?: number;
    chunkDelayMs?: number;
    logFile?: string | null;
};

export type PerfModelServer = {
    endpoint: string;
    port: number;
    flush: () => Promise<void>;
    close: () => Promise<void>;
};

export function startPerfModelServer(options?: PerfModelServerOptions): Promise<PerfModelServer>;
