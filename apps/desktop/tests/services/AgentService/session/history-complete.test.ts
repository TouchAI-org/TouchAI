import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { describe, expect, it } from 'vitest';

describe('given a stored conversation contains multiple exchanges', () => {
    it('user reopens the complete ordered conversation with its saved model identity', async () => {
        const fixture = createAgentWindowFixture();
        fixture.database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (7, 'long-session', 'Long session', 'fixture-model', 1);
            INSERT INTO messages (id, session_id, role) VALUES (1, 7, 'user'), (2, 7, 'assistant'), (3, 7, 'user'), (4, 7, 'assistant');
            INSERT INTO message_parts (message_id, type, content, sort_order) VALUES
            (1, 'text', 'first question', 0), (2, 'text', 'first answer', 0),
            (3, 'text', 'latest question', 0), (4, 'text', 'latest answer', 0);`);
        try {
            const loaded = await fixture.window.api.loadSession(7);
            expect(loaded.history.map((message) => message.content)).toEqual([
                'first question',
                'first answer',
                'latest question',
                'latest answer',
            ]);
            expect(loaded).toMatchObject({
                sessionId: 7,
                title: 'Long session',
                modelId: 'fixture-model',
                providerId: 1,
            });
        } finally {
            await fixture.window.dispose();
        }
    });
});
