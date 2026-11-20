export interface SeededSessionReadiness {
    historyLevel: number;
    mountedMessageIds: string[];
}

export function seededSessionMessageId(historyLevel: number): string | null;
export function isSeededSessionReady(input: SeededSessionReadiness): boolean;
