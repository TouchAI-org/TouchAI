import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import { t, tt } from '@/i18n';
import { createSessionHistory, readSessionHistoryData } from '@/modules/agent';
import { hydratePersistedAttachments } from '@/modules/attachments';
import { createAskUserTools, createToolPresentation } from '@/modules/tools';

afterEach(closeTestDatabases);

function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo)
        VALUES (1, 'Fixture', 'openai-compatible', 'https://fixture.invalid/v1', 'fixture-secret', 'openai');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Fixture', 'fixture-model');
        INSERT INTO sessions (id, session_id, title, model, provider_id) VALUES (1, 'fixture-session', 'History', 'fixture-model', 1);
        INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'user'), (2, 1, 'tool_call'), (3, 1, 'assistant');
        INSERT INTO message_parts (message_id, type, content, sort_order)
        VALUES (1, 'text', 'Stored request', 0), (3, 'text', 'Stored answer', 0);`);
    const data = JSON.stringify({
        toolKind: 'builtin',
        toolCallId: 'stored-question',
        tool_id: 'ask_user_question',
        input: JSON.stringify({
            questions: [
                {
                    question: 'Choose a direction',
                    header: 'Direction',
                    options: [{ label: 'Left' }, { label: 'Right' }],
                },
            ],
        }),
        output: 'Left chosen',
        status: 'success',
        duration_ms: 25,
        conversation_semantic_json: null,
        structured_payload_json: null,
    });
    database
        .prepare(
            `INSERT INTO message_parts (message_id, type, content, sort_order, data) VALUES (2, 'tool_call', '', 0, ?)`
        )
        .run(data);
    const history = createSessionHistory({
        hydrateAttachments: hydratePersistedAttachments,
        tools: createToolPresentation(createAskUserTools({ t, tt }), { t, tt }),
        messages: {
            tt,
            displayError: (message) => message,
            retryText: (attempt, maxRetries) =>
                tt('重试中...({attempt}/{maxRetries})', { attempt, maxRetries }),
        },
        diagnostics: { error: () => {} },
    });
    return { database, history };
}

describe('given committed history and creation-time projection capabilities', () => {
    it('user reopens ordered tool activity and its answer without reading credentials or starting execution', async () => {
        const input = fixture();
        const data = await readSessionHistoryData(1);
        expect(JSON.stringify(data)).not.toMatch(
            /fixture-secret|api_key|api_endpoint|provider_config_json/
        );
        const messages = await input.history.build({ ...data, resolveServerName: () => '' });
        expect(messages.map((message) => message.content)).toEqual([
            'Stored request',
            'Stored answer',
        ]);
        expect(messages[1]?.parts.find((part) => part.type === 'tool_call')).toMatchObject({
            toolCall: {
                id: 'stored-question',
                status: 'completed',
                result: 'Left chosen',
                builtinConversationSemantic: { action: 'ask', target: 'Choose a direction' },
            },
        });
    });

    it('user retains interrupted activity and sees cancellation attached to the existing answer rather than another turn', async () => {
        const input = fixture();
        input.database.exec(`INSERT INTO session_turns (id, session_id, task_id, model_id, status,
            prompt_message_id, response_message_id, prompt_snapshot_json)
            VALUES (1, 1, 'fixture-task', 1, 'cancelled', 1, 3, '{}');`);
        const messages = await input.history.build({
            ...(await readSessionHistoryData(1)),
            resolveServerName: () => '',
        });
        expect(messages).toHaveLength(2);
        expect(messages[1]).toMatchObject({
            content: 'Stored answer',
            statusText: tt('请求已取消'),
        });
    });

    it('user gets a stable missing-session failure and a following stored session can still be opened', async () => {
        const input = fixture();
        await expect(readSessionHistoryData(999)).rejects.toThrow('Session 999 not found');
        expect(
            await input.history.build({
                ...(await readSessionHistoryData(1)),
                resolveServerName: () => '',
            })
        ).toHaveLength(2);
    });
});
