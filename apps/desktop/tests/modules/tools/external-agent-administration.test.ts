import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExternalAgentCardCache } from '@/modules/tools';
import { createExternalAgentAdministration } from '@/modules/tools/external-agents/administration.io';

const AGENT_URL = 'https://agent.example.com';

afterEach(closeTestDatabases);

function agentCard(name: string) {
    return {
        name,
        description: 'A fixture external agent.',
        version: '1.0.0',
        supportedInterfaces: [
            {
                url: AGENT_URL,
                protocolBinding: 'HTTP+JSON',
                protocolVersion: '1.0',
                tenant: '',
            },
        ],
        capabilities: {
            streaming: false,
            pushNotifications: false,
            extendedAgentCard: false,
            extensions: [],
        },
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
    };
}

function createFixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    let now = Date.parse('2026-11-22T00:00:00.000Z');
    let cardName = 'Remote Agent';
    let failure: unknown;
    let beforeResponse: (() => void) | undefined;
    const cache = new ExternalAgentCardCache(() => now);
    const fetchImpl = vi.fn(async () => {
        beforeResponse?.();
        beforeResponse = undefined;
        if (failure) throw failure;
        return new Response(JSON.stringify(agentCard(cardName)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    const { administration, registry } = createExternalAgentAdministration({
        cache,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        discoveryTimeoutMs: 1_000,
        now: () => now,
    });

    return {
        administration,
        cache,
        database,
        fetchImpl,
        registry,
        advance(milliseconds: number) {
            now += milliseconds;
        },
        failDiscovery(error: unknown) {
            failure = error;
        },
        runBeforeNextResponse(action: () => void) {
            beforeResponse = action;
        },
        setCardName(name: string) {
            cardName = name;
        },
    };
}

describe('given a user manages external agents', () => {
    it('user sees added agents listed, re-enabled, deleted, and removed from the cache', async () => {
        const fixture = createFixture();
        const added = await fixture.administration.add({
            allowLoopback: false,
            url: `${AGENT_URL}/agents/one`,
        });

        expect(added).toMatchObject({
            name: 'Remote Agent',
            url: AGENT_URL,
            enabled: 1,
            last_error: null,
        });
        expect(await fixture.administration.findAll()).toEqual([added]);

        expect(await fixture.administration.updateEnabled(added.id, false)).toMatchObject({
            enabled: 0,
        });
        expect(await fixture.registry.findEnabled(added.id)).toBeNull();

        expect(await fixture.administration.updateEnabled(added.id, true)).toMatchObject({
            enabled: 1,
        });
        expect(await fixture.registry.findEnabled(added.id)).toMatchObject({
            card: { name: 'Remote Agent' },
            row: { id: added.id },
        });

        await fixture.administration.delete(added.id);
        expect(await fixture.administration.findAll()).toEqual([]);
        await expect(fixture.registry.list()).resolves.toEqual([]);
        expect(fixture.cache.get(AGENT_URL)).toBeUndefined();

        await expect(fixture.administration.delete(added.id)).resolves.toBeUndefined();
    });

    it('user sees refreshed card details when the agent is rediscovered', async () => {
        const fixture = createFixture();
        const added = await fixture.administration.add({
            allowLoopback: false,
            url: AGENT_URL,
        });
        fixture.setCardName('Updated Remote Agent');
        fixture.advance(60_000);

        const updated = await fixture.administration.rediscover(added.id);

        expect(updated).toMatchObject({
            name: 'Updated Remote Agent',
            last_discovered_at: '2026-11-22T00:01:00.000Z',
            last_error: null,
        });
        expect(await fixture.registry.findEnabled(added.id)).toMatchObject({
            card: { name: 'Updated Remote Agent' },
        });
    });

    it('user sees the previous agent and a recorded error when rediscovery fails', async () => {
        const fixture = createFixture();
        const added = await fixture.administration.add({
            allowLoopback: false,
            url: AGENT_URL,
        });
        fixture.failDiscovery(new Error('fixture network failure'));

        await expect(fixture.administration.rediscover(added.id)).rejects.toMatchObject({
            code: 'discovery_unavailable',
        });
        expect(await fixture.administration.findAll()).toEqual([
            expect.objectContaining({
                id: added.id,
                name: 'Remote Agent',
                last_error: 'discovery_unavailable',
            }),
        ]);
        expect(await fixture.registry.findEnabled(added.id)).toMatchObject({
            card: { name: 'Remote Agent' },
        });
    });

    it('user sees the saved agent usable after the in-memory card cache expires', async () => {
        const fixture = createFixture();
        const added = await fixture.administration.add({
            allowLoopback: false,
            url: AGENT_URL,
        });
        fixture.cache.clear();

        expect(await fixture.registry.findEnabled(added.id)).toMatchObject({
            card: { name: 'Remote Agent' },
            row: { id: added.id },
        });
        expect(await fixture.registry.list()).toEqual([added]);
    });

    it('user sees a malformed saved card rejected instead of called', async () => {
        const fixture = createFixture();
        const added = await fixture.administration.add({
            allowLoopback: false,
            url: AGENT_URL,
        });
        fixture.database.exec(
            `UPDATE external_agents SET agent_card_json = '{"name":"missing interfaces"}' WHERE id = ${added.id}`
        );
        fixture.cache.clear();

        await expect(fixture.registry.findEnabled(added.id)).rejects.toMatchObject({
            code: 'card_malformed',
        });
    });

    it('user sees a missing agent error when rediscovering an unknown record', async () => {
        const fixture = createFixture();

        await expect(fixture.administration.rediscover(999)).rejects.toMatchObject({
            code: 'agent_unavailable',
        });
    });

    it('user sees an unavailable agent when rediscovery loses the saved record', async () => {
        const fixture = createFixture();
        const added = await fixture.administration.add({
            allowLoopback: false,
            url: AGENT_URL,
        });
        fixture.runBeforeNextResponse(() => {
            fixture.database.exec(`DELETE FROM external_agents WHERE id = ${added.id}`);
        });

        await expect(fixture.administration.rediscover(added.id)).rejects.toMatchObject({
            code: 'agent_unavailable',
        });
    });

    it('user sees a malformed persisted URL recorded as unsafe during rediscovery', async () => {
        const fixture = createFixture();
        fixture.database
            .prepare(
                `INSERT INTO external_agents (name, url, protocol, agent_card_json, enabled)
                 VALUES (?, ?, 'a2a', ?, 1)`
            )
            .run('Broken Agent', 'not a URL', JSON.stringify(agentCard('Broken Agent')));

        await expect(fixture.administration.rediscover(1)).rejects.toMatchObject({
            code: 'unsafe_url',
        });
        expect(fixture.database.prepare('SELECT last_error FROM external_agents').get()).toEqual({
            last_error: 'unsafe_url',
        });
    });
});
