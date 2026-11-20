export interface ProcessMemory {
    pssKb: number | null;
    rssKb: number | null;
    privateDirtyKb: number | null;
}

export interface ProcessMemoryTotals {
    totalPssKb: number | null;
    totalRssKb: number | null;
    totalPrivateDirtyKb: number | null;
}

export interface ProcessCandidate {
    pid: number;
    cgroup: string;
    environment: string[];
}

export interface ProcessRunIdentity {
    appPids: Set<number>;
    appCgroups: Set<string>;
    environmentMarker: string;
    runTokenMarker: string;
}

export function readRollup(pid: number): ProcessMemory | null;
export function aggregateMemory(processes: ProcessMemory[]): ProcessMemoryTotals;
export function processBelongsToRun(
    candidate: ProcessCandidate,
    identity: ProcessRunIdentity
): boolean;
