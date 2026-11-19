import { createAgentWindowFixture, network, response } from '@tests/utils/agentWindow';
import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';

async function savedTitle(prompt: string): Promise<string> {
    const fixture = createAgentWindowFixture();
    network.replies.push(response('answer'));
    try {
        const started = await fixture.window.api.startTask({ prompt });
        await started.completion;
        const sessionId = fixture.window.api.getTaskSnapshot(started.taskId)!.sessionId!;
        return (await fixture.window.api.getSession(sessionId)).title;
    } finally {
        await fixture.window.dispose();
    }
}

describe('given the main host names a new conversation', () => {
    beforeEach(() => setLocale('en-US'));

    it('user gets a localized default title when the prompt contains only whitespace', async () => {
        expect(await savedTitle('   ')).toBe('New session');
    });

    it('user keeps their own words in the title when the interface uses another language', async () => {
        expect(await savedTitle('写一份项目计划')).toBe('写一份项目计划');
    });
});
