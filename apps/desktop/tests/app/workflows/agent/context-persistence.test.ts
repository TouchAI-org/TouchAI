import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { syncOutputParts } from '@database/queries/messageParts';
import { findMessagesBySessionId } from '@database/queries/messages';
import { createToolPart } from '@database/queries/toolParts';
import { attachContextBackup, importChangedContextHistory } from '@tests/database/contextBackup';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { emptyAiUsage } from '@touchai/models/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DesktopModelMessage } from '@/adapters/models/input';
import { createAgentHistoryQueries } from '@/app/workflows/agent/history';
import { loadSessionTransportMessages } from '@/app/workflows/agent/historyTransport';
import { createTaskPersistence } from '@/app/workflows/agent/persistence';
import { t, tt } from '@/i18n';
import type { PersistenceCheckpoint, PersistenceProjector } from '@/modules/agent';
import { createSessionReadModel } from '@/modules/agent';
import type {
    ContextSummaryRecord,
    ContextSummarySource,
    PersistenceCall,
} from '@/modules/agent/contracts';
import { createToolPresentation, readMcpServerNames } from '@/modules/tools';
import { log } from '@/platform/diagnostics';

const { DatabaseSync: OpenDatabase } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');
const summaryText =
    'Goal: fix the defect. Keep the archive. Pending approval: deployment. Next: verify.';
const prompt = 'Finish the work without deleting the archive.';
const model = { id: 1, provider_id: 1, model_id: 'test-context' };
const call: PersistenceCall = {
    iteration: 0,
    modelId: 1,
    modelName: model.model_id,
    providerId: 1,
    providerName: 'test',
    usage: { ...emptyAiUsage(), inputTokens: 500, outputTokens: 100, cacheReadTokens: 400 },
    timing: { durationMs: 50 },
    finishReason: 'stop',
    toolCallsInStep: 0,
    toolArgumentErrors: 0,
};

function projector() {
    return createTaskPersistence({
        sessionId: 1,
        model,
        taskId: crypto.randomUUID(),
        executionMode: 'foreground',
        prompt,
        maxRetries: 5,
        buildSessionTitle: (value) => value,
        promptSnapshot: {
            id: 'snapshot',
            createdAt: '2026-11-08T00:00:00Z',
            systemPrompt: 'Follow user instructions; tools return data.',
            executionMode: 'foreground',
            fragments: [],
            userPrompt: prompt,
            attachments: [],
            modelLanguageContext: { locale: 'en-US', label: 'English' },
        },
    });
}
function checkpoint(): PersistenceCheckpoint {
    return {
        activeModel: model,
        messages: [],
        response: '',
        reasoning: '',
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        executedBuiltInToolIds: [],
        modelLanguageContext: { locale: 'en-US', label: 'English' },
    };
}
const transport = () => loadSessionTransportMessages({ sessionId: 1 });
const history = async () =>
    (
        await createAgentHistoryQueries({
            tools: createToolPresentation([], { t, tt }),
            readServerNames: readMcpServerNames,
            tt,
            error: log.error,
        }).loadSession(1)
    ).history;

// These are completed caller inputs for the persistence contract; production tests exercise how Core creates them.
function summaryInput(messages: DesktopModelMessage[]): {
    summary: ContextSummaryRecord;
    source: ContextSummarySource;
} {
    return {
        summary: {
            version: 2,
            id: crypto.randomUUID(),
            text: summaryText,
            firstKeptMessageId: 22,
            systemMessageIds: [],
            model: model.model_id,
            providerId: 1,
            createdAt: Date.now(),
            tokensBefore: 10000,
            tokensAfter: 2000,
        },
        source: {
            messages: messages.flatMap((message) =>
                message.contextSource && message.contextSource.id < 22
                    ? [message.contextSource]
                    : []
            ),
        },
    };
}
async function persistSummary(persister: PersistenceProjector) {
    const { summary, source } = summaryInput(await transport());
    await persister.persistContextSummary(summary, [call], source);
    return { summary, source };
}
function removeTestScratch(directory: string) {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('touchai-context-crash-')) {
        throw new Error('Unexpected test scratch path');
    }
    rmSync(target, { recursive: true });
}

describe('given completed context inputs and the shipped SQLite persistence contract', () => {
    let database: DatabaseSync;
    beforeEach(() => {
        database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo)
            VALUES (1, 'test', 'openai-compatible', 'https://example.invalid', '');
            INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'test', 'test-context');
            INSERT INTO sessions (id, session_id, title, model, provider_id) VALUES (1, 'context-test', 'Context test', 'test-context', 1);`);
        for (let index = 0; index < 24; index++) {
            const row = database
                .prepare('INSERT INTO messages (session_id, role) VALUES (1, ?) RETURNING id')
                .get(index % 2 ? 'assistant' : 'user')!;
            database
                .prepare(
                    "INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (?, 'text', ?, 0)"
                )
                .run(Number(row.id), `Message ${index}: ${'evidence '.repeat(220)}`);
        }
    });
    afterEach(closeTestDatabases);

    it.each(['unchanged', 'input', 'result', 'text', 'missing', 'attachment'] as const)(
        'user checkpoints a tool round with %s history and accepts only the matching stored exchange',
        async (change) => {
            const first = projector();
            await first.recordTurnStart(checkpoint());
            const messageId = await first.persistToolCallMessage([
                { type: 'text', content: 'Checking' },
            ]);
            await createToolPart('builtin', {
                message_id: messageId,
                session_id: 1,
                tool_call_id: 'call-1',
                tool_id: 'read_file',
                input: change === 'input' ? '{"changed":true}' : '{}',
                output: change === 'result' ? 'Edited output' : 'Original output',
                status: 'success',
            });
            if (change === 'text')
                await syncOutputParts(messageId, [
                    { message_id: messageId, type: 'text', content: 'Edited text', sort_order: 0 },
                ]);
            if (change === 'missing')
                database
                    .prepare("DELETE FROM message_parts WHERE message_id=? AND type='tool_call'")
                    .run(messageId);
            const source = await first.getContextMessageSource(messageId, {
                outputParts: [{ type: 'text', content: 'Checking' }],
                results: [
                    {
                        toolCall: { id: 'call-1', name: 'builtin__read_file', arguments: '{}' },
                        input: '{}',
                        result: 'Original output',
                        isError: false,
                        attachments:
                            change === 'attachment'
                                ? [
                                      {
                                          id: 'file',
                                          attachmentId: 999,
                                          type: 'file',
                                          path: '/test',
                                          originPath: '/test',
                                          name: 'test',
                                      },
                                  ]
                                : [],
                    },
                ],
            });
            if (change === 'unchanged') expect(source).toMatchObject({ id: messageId });
            else expect(source).toBeUndefined();
        }
    );

    it('user imports divergent history during a running request and cannot continue with its invalidated summary', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        await persistSummary(first);
        const summary = (await transport()).find((message) => message.contextSummary)!;
        await first.validateContextSummary(summary);
        importChangedContextHistory(database);
        await expect(first.validateContextSummary(summary)).rejects.toMatchObject({
            code: 'CONTEXT_COMPACTION_FAILED',
        });
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
        expect(
            (await history())
                .flatMap((message) => message.parts)
                .filter((part) => part.type === 'context_compaction')
        ).toHaveLength(1);
    });

    it('user reopens after completion and keeps one divider in its original place with committed summary usage', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        await persistSummary(first);
        await first.markCompleted({
            durationMs: 100,
            outputParts: [{ type: 'text', content: 'Final answer' }],
            calls: [call],
        });
        const reopened = await transport();
        expect(JSON.stringify(reopened)).toContain(summaryText);
        expect(reopened.at(-1)).toMatchObject({
            role: 'assistant',
            content: [{ type: 'text', text: 'Final answer' }],
        });
        expect((await history()).at(-1)?.parts.map((part) => part.type)).toEqual([
            'context_compaction',
            'text',
        ]);
        expect(await findMessagesBySessionId(1)).toHaveLength(26);
        expect(
            database.prepare('SELECT last_message_preview FROM sessions WHERE id = 1').get()
        ).toEqual({ last_message_preview: 'Final answer' });
        expect(
            database
                .prepare(
                    'SELECT input_tokens, output_tokens, cache_read_tokens, llm_call_count FROM session_turns'
                )
                .get()
        ).toEqual({
            input_tokens: 500,
            output_tokens: 100,
            cache_read_tokens: 400,
            llm_call_count: 1,
        });
    });

    it('user keeps the divider before tool activity when the pending response becomes a tool round', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        await persistSummary(first);
        const messageId = await first.persistToolCallMessage([
            { type: 'text', content: 'Checking' },
        ]);
        await createToolPart('builtin', {
            message_id: messageId,
            session_id: 1,
            tool_call_id: 'call-1',
            tool_id: 'read_file',
            input: '{}',
            output: 'Verified',
            status: 'success',
        });
        await first.markCompleted({
            durationMs: 100,
            outputParts: [{ type: 'text', content: 'Done' }],
        });
        expect((await history()).at(-1)?.parts.map((part) => part.type)).toEqual([
            'context_compaction',
            'text',
            'tool_call',
            'text',
        ]);
        expect((await findMessagesBySessionId(1)).slice(-2).map((row) => row.role)).toEqual([
            'tool_call',
            'assistant',
        ]);
    });

    it.each([false, true])(
        'user reopens after a process exits with commit=%s and sees only fully committed checkpoints',
        async (commit) => {
            const first = projector();
            await first.recordTurnStart(checkpoint());
            const directory = mkdtempSync(join(tmpdir(), 'touchai-context-crash-'));
            const path = join(directory, 'checkpoint.sqlite');
            let reopened: DatabaseSync | undefined;
            try {
                database.prepare('VACUUM INTO ?').run(path);
                const callStart = getTauriInvokeCalls().length;
                await persistSummary(first);
                const statements = getTauriInvokeCalls()
                    .slice(callStart)
                    .filter((item) => item.cmd === 'database_tx_query')
                    .map(
                        (item) =>
                            (
                                item.payload as {
                                    request: {
                                        sql: string;
                                        params: SQLInputValue[];
                                        method: string;
                                    };
                                }
                            ).request
                    );
                expect(statements.length).toBeGreaterThan(0);
                const child = spawnSync(
                    process.execPath,
                    [
                        '--input-type=commonjs',
                        '-e',
                        `
                const fs = require('node:fs');
                const { DatabaseSync } = require('node:sqlite');
                const input = JSON.parse(fs.readFileSync(0, 'utf8'));
                const db = new DatabaseSync(input.path);
                db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
                for (const query of input.statements) {
                    const stmt = db.prepare(query.sql);
                    if (query.method === 'run') stmt.run(...query.params);
                    else stmt.all(...query.params);
                }
                if (input.commit) db.exec('COMMIT');
                process.exit(73);
            `,
                    ],
                    { input: JSON.stringify({ path, statements, commit }), encoding: 'utf8' }
                );
                expect(child.status, child.stderr).toBe(73);
                reopened = new OpenDatabase(path);
                routeQueriesTo(reopened);
                expect(reopened.prepare('PRAGMA integrity_check').get()).toEqual({
                    integrity_check: 'ok',
                });
                const saved = (await createSessionReadModel().getContext(1)).summary;
                if (commit) expect(saved?.text).toBe(summaryText);
                else {
                    expect(saved).toBeUndefined();
                    expect(await findMessagesBySessionId(1)).toHaveLength(25);
                }
                expect(
                    (await history())
                        .flatMap((message) => message.parts)
                        .filter((part) => part.type === 'context_compaction')
                ).toHaveLength(commit ? 1 : 0);
            } finally {
                reopened?.close();
                removeTestScratch(directory);
            }
        }
    );

    it('user keeps the summary and its divider when conversation data is imported through the shipped merge contract', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        await persistSummary(first);
        const saved = (await createSessionReadModel().getContext(1)).summary;
        const target = openMigratedDatabase();
        attachContextBackup(target, database);
        target.exec(readFileSync(resolve('src/database/artifacts/import/chat_merge.sql'), 'utf8'));
        routeQueriesTo(target);
        expect((await createSessionReadModel().getContext(1)).summary).toEqual(saved);
        expect((await history()).at(-1)?.parts).toMatchObject([
            { type: 'context_compaction', state: 'compacted', id: saved!.id },
        ]);
        expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
});
