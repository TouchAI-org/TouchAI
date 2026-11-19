import { createAgentWindowFixture, network } from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentApiKey } from '@/app/api/agent';
import { useAgent } from '@/composables/agent/useAgent';
import { setLocale } from '@/i18n';

const notification = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({ sendNotification: notification.send }));
let fixture: ReturnType<typeof createAgentWindowFixture>;
const unmounts: (() => void)[] = [];
beforeEach(async () => {
    fixture = createAgentWindowFixture();
    await fixture.window.ready;
    setLocale('en-US');
    notification.send.mockClear();
});
afterEach(async () => {
    for (const unmount of unmounts.splice(0)) unmount();
    await fixture.window.dispose();
    setLocale('zh-CN');
});
async function mountAgent() {
    const view = await mountComposable(useAgent, (app) =>
        app.provide(agentApiKey, fixture.window.api)
    );
    unmounts.push(view.unmount);
    return view.result;
}

describe('given the app uses the production Agent client in English', () => {
    it('user submits a blank prompt and receives a localized error without starting a task', async () => {
        const agent = await mountAgent();
        await agent.sendRequest('   ');
        expect(agent.error.value?.message).toBe('Enter a request');
        expect(fixture.window.api.listActiveTasks()).toEqual([]);
        expect(network.requests).toEqual([]);
    });

    it('user receives the localized pre-admission failure notification when the main owner is closed', async () => {
        const agent = await mountAgent();
        await fixture.window.dispose();
        await agent.sendRequest('hello');
        expect(agent.error.value?.message).toBe('AGENT_DISPOSED');
        expect(notification.send).toHaveBeenCalledWith({
            title: 'TouchAI - Request failed',
            body: 'AGENT_DISPOSED',
        });
        expect(network.requests).toEqual([]);
    });
});
