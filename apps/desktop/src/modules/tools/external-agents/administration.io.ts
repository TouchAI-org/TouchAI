import {
    createExternalAgent,
    deleteExternalAgent,
    findAllExternalAgents,
    findExternalAgentById,
    updateExternalAgent,
} from '@database/queries/externalAgents';
import type { ExternalAgent } from '@database/schema';

import type { ExternalAgentCardCache } from './cardCache';
import type {
    ExternalAgentAdministration,
    ExternalAgentCard,
    ExternalAgentRegistry,
} from './contracts';
import { ExternalAgentError } from './errors';
import { isLoopbackExternalAgentUrl, parseExternalAgentUrl } from './urlPolicy';

export function createExternalAgentAdministration(input: {
    cache: ExternalAgentCardCache;
    fetchImpl: typeof fetch;
    discoveryTimeoutMs: number;
    now: () => number;
}): { administration: ExternalAgentAdministration; registry: ExternalAgentRegistry } {
    const remember = (row: ExternalAgent, discovered: ExternalAgentCard) => {
        input.cache.set(row.url, discovered);
        return row;
    };

    async function discover(url: string, allowLoopback: boolean): Promise<ExternalAgentCard> {
        const { discoverExternalAgent } = await import('./discovery');
        return await discoverExternalAgent({
            allowLoopback,
            fetchImpl: input.fetchImpl,
            timeoutMs: input.discoveryTimeoutMs,
            url,
        });
    }

    const administration = Object.freeze<ExternalAgentAdministration>({
        async findAll() {
            return await findAllExternalAgents();
        },
        async add({ allowLoopback, url }) {
            const parsed = parseExternalAgentUrl(url, allowLoopback);
            const normalized = parsed.origin;
            const discovered = await discover(normalized, allowLoopback);
            const now = new Date(input.now()).toISOString();
            const row = await createExternalAgent({
                name: discovered.card.name,
                url: normalized,
                protocol: 'a2a',
                agent_card_json: JSON.stringify(discovered.card),
                enabled: 1,
                last_discovered_at: now,
                last_error: null,
            });
            return remember(row, discovered);
        },
        async rediscover(id) {
            const existing = await findExternalAgentById(id);
            if (!existing) throw new ExternalAgentError('agent_unavailable');
            let allowLoopback = false;
            try {
                allowLoopback = isLoopbackExternalAgentUrl(new URL(existing.url));
            } catch {
                // The persisted row still goes through the URL policy below.
            }
            try {
                const discovered = await discover(existing.url, allowLoopback);
                const updated = await updateExternalAgent(id, {
                    name: discovered.card.name,
                    protocol: 'a2a',
                    agent_card_json: JSON.stringify(discovered.card),
                    last_discovered_at: new Date(input.now()).toISOString(),
                    last_error: null,
                });
                if (!updated) throw new ExternalAgentError('agent_unavailable');
                return remember(updated, discovered);
            } catch (error) {
                const code =
                    error instanceof ExternalAgentError ? error.code : 'discovery_unavailable';
                await updateExternalAgent(id, { last_error: code });
                throw error instanceof ExternalAgentError
                    ? error
                    : new ExternalAgentError(code, { cause: error });
            }
        },
        async updateEnabled(id, enabled) {
            return await updateExternalAgent(id, { enabled: enabled ? 1 : 0 });
        },
        async delete(id) {
            const existing = await findExternalAgentById(id);
            await deleteExternalAgent(id);
            if (existing) input.cache.delete(existing.url);
        },
    });

    const registry = Object.freeze<ExternalAgentRegistry>({
        async findEnabled(id) {
            const row = await findExternalAgentById(id);
            if (!row || row.enabled !== 1) return null;
            try {
                const cached = input.cache.get(row.url);
                if (cached) return { card: cached.card, row };
                const parsed = JSON.parse(row.agent_card_json) as unknown;
                const loopback = isLoopbackExternalAgentUrl(new URL(row.url));
                const baseUrl = parseExternalAgentUrl(row.url, loopback);
                const { parseExternalAgentCard, resolveCompatibleInterface } =
                    await import('./discovery');
                const card = parseExternalAgentCard(parsed);
                const discovered = {
                    card,
                    compatibleInterface: resolveCompatibleInterface(card, baseUrl, loopback),
                    origin: baseUrl.origin,
                    url: baseUrl.origin,
                };
                input.cache.set(row.url, discovered);
                return { card: discovered.card, row };
            } catch (error) {
                throw error instanceof ExternalAgentError
                    ? error
                    : new ExternalAgentError('card_malformed', { cause: error });
            }
        },
        async list() {
            return await findAllExternalAgents();
        },
    });
    return { administration, registry };
}
