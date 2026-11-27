import type { ExternalAgentCard } from './contracts';

export const EXTERNAL_AGENT_CARD_CACHE_LIMIT = 32;
export const EXTERNAL_AGENT_CARD_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
    expiresAt: number;
    value: ExternalAgentCard;
}

export class ExternalAgentCardCache {
    private readonly entries = new Map<string, CacheEntry>();

    constructor(
        private readonly now: () => number = Date.now,
        private readonly ttlMs = EXTERNAL_AGENT_CARD_CACHE_TTL_MS,
        private readonly limit = EXTERNAL_AGENT_CARD_CACHE_LIMIT
    ) {}

    get(key: string): ExternalAgentCard | undefined {
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: ExternalAgentCard): void {
        this.entries.delete(key);
        this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
        while (this.entries.size > this.limit) {
            const oldest = this.entries.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    delete(key: string): void {
        this.entries.delete(key);
    }

    clear(): void {
        this.entries.clear();
    }

    get size(): number {
        return this.entries.size;
    }
}
