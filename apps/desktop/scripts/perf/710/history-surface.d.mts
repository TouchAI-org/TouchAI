export interface HistorySurfaceSelection {
    originalHandle: string;
    handles: string[];
    rowHandles: string[];
}

export function selectHistorySurface(input: HistorySurfaceSelection): string | null;
