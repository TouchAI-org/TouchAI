import { mockWindows } from '@tauri-apps/api/mocks';
import { createAgentWindowFixture, network } from '@tests/utils/agentWindow';
import { afterEach, describe, expect, it } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

const hosts: ReturnType<typeof initializeAgentWindow>[] = [];

afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

function card() {
    return {
        name: 'Remote fixture',
        description: 'A fixture agent.',
        version: '1.0.0',
        supportedInterfaces: [
            {
                url: 'https://agent.example.com',
                protocolBinding: 'HTTP+JSON',
                protocolVersion: '1.0',
                tenant: '',
            },
        ],
        capabilities: {
            streaming: true,
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

async function fixture() {
    network.respondToDiscovery = async () =>
        new Response(JSON.stringify(card()), {
            headers: { 'Content-Type': 'application/json' },
        });
    const main = createAgentWindowFixture();
    hosts.push(main.window);
    await main.window.ready;
    mockWindows('settings');
    const settings = initializeAgentWindow();
    hosts.push(settings);
    return { main, settings };
}

describe('given the external agent settings boundary', () => {
    it('user adds discovers toggles and deletes an external agent through main without receiving the raw card', async () => {
        const { main, settings } = await fixture();
        const api = settings.externalAgentsAdministration!;

        const added = await api.add({
            url: 'https://agent.example.com',
            allowLoopback: false,
        });
        expect(added).toMatchObject({
            name: 'Remote fixture',
            url: 'https://agent.example.com',
            protocol: 'a2a',
            enabled: 1,
            last_error: null,
        });
        expect(added).not.toHaveProperty('agent_card_json');
        expect(main.database.prepare('SELECT name, enabled FROM external_agents').get()).toEqual({
            name: 'Remote fixture',
            enabled: 1,
        });

        await api.updateEnabled(added.id, false);
        expect((await api.findAll())[0]).toMatchObject({ enabled: 0 });

        await api.delete(added.id);
        expect(await api.findAll()).toEqual([]);
    });

    it('user sees a safe command failure when settings tries to add an unsafe URL', async () => {
        const { main, settings } = await fixture();
        await expect(
            settings.externalAgentsAdministration!.add({
                url: 'http://10.0.0.1',
                allowLoopback: true,
            })
        ).rejects.toMatchObject({
            code: 'EXTERNAL_AGENT_COMMAND_FAILED',
            message: 'EXTERNAL_AGENT_COMMAND_FAILED',
        });
        expect(main.database.prepare('SELECT id FROM external_agents').all()).toEqual([]);
    });
});
