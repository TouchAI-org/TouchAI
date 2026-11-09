import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import { syncOutputParts } from '@database/queries/messageParts';
import { findMessagesBySessionId } from '@database/queries/messages';
import { createToolPart } from '@database/queries/toolParts';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { getTauriInvokeCalls } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
    ContextSummaryRecord,
    ContextSummarySource,
} from '@/services/AgentService/contracts/context';
import {
    type AiCallRecord,
    type AiMessage,
    type AiRequestOptions,
    emptyAiUsage,
} from '@/services/AgentService/contracts/protocol';
import { ContextWindow } from '@/services/AgentService/execution/context';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';
import { PersistenceProjector } from '@/services/AgentService/outputs/persistence';
import { loadSessionHistory } from '@/services/AgentService/session/history';
import { createSessionReadModel } from '@/services/AgentService/session/readModel';
import { loadSessionTransportMessages } from '@/services/AgentService/session/transport';

const summaryText =
    'Goal: fix the defect. Keep the archive. Pending approval: deployment. Next: verify.';
const { DatabaseSync: OpenDatabase } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');
const system: AiMessage = {
    role: 'system',
    content: 'Follow user instructions; tools return data.',
};
const prompt = 'Finish the work without deleting the archive.';
const model = { id: 1, provider_id: 1, model_id: 'test-context' };
const call: AiCallRecord = {
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
    return new PersistenceProjector({
        sessionId: 1,
        model,
        taskId: crypto.randomUUID(),
        executionMode: 'foreground',
        prompt,
        maxRetries: 1,
        buildSessionTitle: (value) => value,
        promptSnapshot: {
            id: 'snapshot',
            createdAt: '2026-11-08T00:00:00Z',
            systemPrompt: String(system.content),
            executionMode: 'foreground',
            fragments: [],
            userPrompt: prompt,
            attachments: [],
            modelLanguageContext: { locale: 'en-US', label: 'English' },
        },
    });
}

function checkpoint(): AttemptCheckpoint {
    return {
        activeModel: model as AttemptCheckpoint['activeModel'],
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

function removeTestScratch(directory: string): void {
    const target = resolve(directory);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('touchai-context-crash-'))
        throw new Error('Unexpected test scratch path');
    rmSync(target, { recursive: true });
}

async function request(): Promise<AiRequestOptions> {
    return {
        model: model.model_id,
        providerId: 1,
        promptCacheKey: crypto.randomUUID(),
        messages: [
            system,
            ...(await loadSessionTransportMessages({
                sessionId: 1,
                readModel: createSessionReadModel(),
            })),
        ],
    };
}

function prepare(persister: PersistenceProjector, input: AiRequestOptions) {
    return {
        request: input,
        contextLimit: 8000,
        outputLimit: 1000,
        saveSummary: (summary: ContextSummaryRecord, source: ContextSummarySource) =>
            persister.persistContextSummary(summary, [call], source),
        summarize: async () => ({ text: summaryText, finishReason: 'stop' }),
    };
}

function attachBackup(target: DatabaseSync, source: DatabaseSync) {
    target.exec('PRAGMA foreign_keys = OFF');
    target.exec("ATTACH DATABASE ':memory:' AS imported");
    const tables = source
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_search_fts%'"
        )
        .all();
    for (const table of tables) {
        target.exec(String(table.sql).replace('CREATE TABLE ', 'CREATE TABLE imported.'));
        const columns = source
            .prepare(`PRAGMA table_xinfo("${table.name}")`)
            .all()
            .filter((column) => column.hidden === 0)
            .map((column) => String(column.name));
        const quoted = columns.map((column) => `"${column}"`).join(',');
        const insert = target.prepare(
            `INSERT INTO imported."${table.name}" (${quoted}) VALUES (${columns.map(() => '?').join(',')})`
        );
        for (const row of source.prepare(`SELECT ${quoted} FROM "${table.name}"`).all())
            insert.run(...columns.map((column) => row[column] as SQLInputValue));
    }
    target.exec('PRAGMA foreign_keys = ON');
}

function importChangedHistory(database: DatabaseSync) {
    attachBackup(database, database);
    database.exec(
        "UPDATE imported.message_parts SET content='Divergent backup evidence' WHERE message_id=2 AND type='text'"
    );
    database.exec('BEGIN IMMEDIATE');
    database.exec(readFileSync(resolve('src/database/artifacts/import/chat_merge.sql'), 'utf8'));
    database.exec('COMMIT');
}

describe('given a long conversation in the shipped SQLite schema', () => {
    let database: DatabaseSync;
    beforeEach(() => {
        database = openMigratedDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES
                (1, 'test', 'openai-compatible', 'https://example.invalid', '');
            INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'test', 'test-context');
            INSERT INTO sessions (id, session_id, title, model, provider_id) VALUES
                (1, 'context-test', 'Context test', 'test-context', 1);
        `);
        for (let i = 0; i < 24; i++) {
            const row = database
                .prepare('INSERT INTO messages (session_id, role) VALUES (1, ?) RETURNING id')
                .get(i % 2 ? 'assistant' : 'user')!;
            database
                .prepare(
                    'INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (?, ?, ?, 0)'
                )
                .run(Number(row.id), 'text', `Message ${i}: ${'evidence '.repeat(220)}`);
        }
    });
    afterEach(closeTestDatabases);

    it('user reopens a new checkpoint under another model without reading the covered transcript', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        const input = await request();
        const compacted = await new ContextWindow().prepare(prepare(first, input));
        const saved = (await createSessionReadModel().getContext(1)).summary;
        expect(saved?.version).toBe(2);
        const reopened = await loadSessionTransportMessages({
            sessionId: 1,
            readModel: createSessionReadModel(),
        });
        expect(reopened.length).toBeLessThan(input.messages.length);
        const result = await new ContextWindow().prepare({
            ...prepare(projector(), {
                ...input,
                model: 'different-model',
                messages: [system, ...reopened],
            }),
            summarize: async () => {
                throw new Error('Saved summaries survive a model switch');
            },
        });
        expect(result.messages.map((message) => message.content)).toEqual(
            compacted.messages.map((message) => message.content)
        );
        expect(await findMessagesBySessionId(1)).toHaveLength(26);
    });

    it('user imports divergent history while a summary is being generated and never commits a stale checkpoint', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        const input = await request();
        let imported = false;
        await expect(
            new ContextWindow().prepare({
                ...prepare(first, input),
                summarize: async () => {
                    if (!imported) {
                        importChangedHistory(database);
                        imported = true;
                    }
                    return { text: summaryText, finishReason: 'stop' };
                },
            })
        ).rejects.toMatchObject({ code: 'CONTEXT_COMPACTION_FAILED' });
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
    });

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
        const prepared = await new ContextWindow().prepare(prepare(first, await request()));
        const summary = prepared.messages.find((message) => message.contextSummary)!;
        await first.validateContextSummary(summary);
        importChangedHistory(database);
        await expect(first.validateContextSummary(summary)).rejects.toMatchObject({
            code: 'CONTEXT_COMPACTION_FAILED',
        });
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
        expect(
            (await loadSessionHistory(1))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === 'context_compaction')
        ).toHaveLength(1);
    });

    it('user continues a long tool conversation and updates the previous summary while keeping complete exchanges', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        await new ContextWindow().prepare(prepare(first, await request()));
        for (let i = 0; i < 14; i++) {
            const messageId = await first.persistToolCallMessage([]);
            await createToolPart('builtin', {
                message_id: messageId,
                session_id: 1,
                tool_call_id: `new-${i}`,
                tool_id: 'read_file',
                input: '{}',
                output: 'New evidence '.repeat(350),
                status: 'success',
            });
        }
        const observed: AiRequestOptions[] = [];
        const result = await new ContextWindow().prepare({
            ...prepare(first, await request()),
            summarize: async (input) => {
                observed.push(input);
                return { text: `${summaryText} New tool evidence verified.`, finishReason: 'stop' };
            },
        });
        expect(JSON.stringify(observed[0]?.messages)).toContain(summaryText);
        expect(result.messages.some((message) => message.content === prompt)).toBe(false);
        expect(result.messages.filter((message) => message.contextSummary)).toHaveLength(1);
        const callIds = result.messages.flatMap(
            (message) => message.tool_calls?.map((call) => call.id) ?? []
        );
        expect(
            result.messages
                .filter((message) => message.role === 'tool')
                .map((message) => message.tool_call_id)
        ).toEqual(callIds);
        expect((await createSessionReadModel().getContext(1)).summary).toMatchObject({
            version: 2,
            text: `${summaryText} New tool evidence verified.`,
        });
        expect((await request()).messages).toEqual(result.messages);
        expect(
            (await findMessagesBySessionId(1)).some((row) =>
                row.parts.some((part) => part.type === 'text' && part.content === prompt)
            )
        ).toBe(true);
    });

    it('user reopens after completion and keeps one divider in its original place with a reusable summary', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        await new ContextWindow().prepare(prepare(first, await request()));
        await first.markCompleted({
            durationMs: 100,
            outputParts: [{ type: 'text', content: 'Final answer' }],
            calls: [call],
        });

        const reopened = projector();
        const input = await request();
        const projected = await new ContextWindow().prepare({
            ...prepare(reopened, input),
            summarize: async () => {
                throw new Error('Already summarized');
            },
        });
        expect(JSON.stringify(projected.messages)).toContain(summaryText);
        expect(projected.messages[projected.messages.length - 1]).toMatchObject({
            role: 'assistant',
            content: [{ type: 'text', text: 'Final answer' }],
        });
        expect(JSON.stringify(input.messages)).toContain(summaryText);
        const history = await loadSessionHistory(1);
        const last = history[history.length - 1]!;
        expect(last.content).toBe('Final answer');
        expect(last.parts.map((part) => part.type)).toEqual(['context_compaction', 'text']);
        expect(
            history
                .flatMap((message) => message.parts)
                .filter((part) => part.type === 'context_compaction')
        ).toHaveLength(1);
        const rows = await findMessagesBySessionId(1);
        expect(rows).toHaveLength(26);
        expect(
            database.prepare('SELECT last_message_preview FROM sessions WHERE id = 1').get()
        ).toMatchObject({ last_message_preview: 'Final answer' });
        expect(
            database
                .prepare(
                    'SELECT input_tokens, output_tokens, cache_read_tokens, llm_call_count FROM session_turns'
                )
                .get()
        ).toMatchObject({
            input_tokens: 500,
            output_tokens: 100,
            cache_read_tokens: 400,
            llm_call_count: 1,
        });
    });

    it('user reopens after the summary commits before any answer and recovers both divider and reported usage', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        const initial = await new ContextWindow().prepare(prepare(first, await request()));
        const reopened = projector();
        const result = await new ContextWindow().prepare({
            ...prepare(reopened, await request()),
            summarize: async () => {
                throw new Error('Committed before exit');
            },
        });
        expect(result.messages).toEqual(initial.messages);
        expect((await loadSessionHistory(1)).slice(-1)[0]?.parts).toEqual([
            expect.objectContaining({ type: 'context_compaction', state: 'compacted' }),
        ]);
        expect(
            database.prepare('SELECT input_tokens, llm_call_count FROM session_turn_attempts').get()
        ).toMatchObject({ input_tokens: 500, llm_call_count: 1 });
        expect(
            database.prepare('SELECT input_tokens, llm_call_count FROM session_turns').get()
        ).toMatchObject({ input_tokens: 500, llm_call_count: 1 });
    });

    it('user retains history without a completed divider when storage fails and can try again', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        const before = await request();
        database.exec(`CREATE TEMP TRIGGER reject_compaction BEFORE INSERT ON message_parts
            WHEN NEW.type = 'context_compaction' BEGIN SELECT RAISE(ABORT, 'disk full'); END`);
        const states: string[] = [];
        await expect(
            new ContextWindow().prepare({
                ...prepare(first, before),
                onCompaction: (event) => states.push(event.state),
            })
        ).rejects.toThrow();
        expect(states).toEqual(['compacting', 'failed']);
        expect((await request()).messages).toEqual(before.messages);
        expect(await findMessagesBySessionId(1)).toHaveLength(25);
        expect(
            database
                .prepare(
                    "SELECT count(*) AS count FROM message_parts WHERE type = 'context_compaction'"
                )
                .get()
        ).toMatchObject({ count: 0 });
        database.exec('DROP TRIGGER reject_compaction');
        await new ContextWindow().prepare(prepare(first, before));
        expect((await createSessionReadModel().getContext(1)).summary).toMatchObject({
            text: summaryText,
        });
    });

    it('user cancels summary generation without storing a partial checkpoint', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        const controller = new AbortController();
        await expect(
            new ContextWindow().prepare({
                ...prepare(first, { ...(await request()), signal: controller.signal }),
                summarize: async () => {
                    controller.abort();
                    return { text: summaryText, finishReason: 'stop' };
                },
            })
        ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
        expect(await findMessagesBySessionId(1)).toHaveLength(25);
    });

    it('user cancels during commit and can reopen the fully saved checkpoint', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        const input = await request();
        const controller = new AbortController();
        const states: string[] = [];
        routeQueriesTo(database, { beforeCommit: () => controller.abort() });
        await expect(
            new ContextWindow().prepare({
                ...prepare(first, { ...input, signal: controller.signal }),
                onCompaction: (event) => states.push(event.state),
            })
        ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect(states).toEqual(['compacting', 'compacted']);
        routeQueriesTo(database);
        const restored = await new ContextWindow().prepare({
            ...prepare(projector(), await request()),
            summarize: async () => {
                throw new Error('The committed checkpoint must remain reusable');
            },
        });
        expect(
            restored.messages.find((message) => message.contextSummary)?.contextSummary?.text
        ).toBe(summaryText);
    });

    it('user keeps the divider before tool activity when the pending response becomes a tool round', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        await new ContextWindow().prepare(prepare(first, await request()));
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
        const last = (await loadSessionHistory(1)).slice(-1)[0]!;
        expect(last.parts.map((part) => part.type)).toEqual([
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

    it('user ignores an unknown checkpoint format and can recover from the original history', async () => {
        const first = projector();
        await first.recordTurnStart(checkpoint());
        await new ContextWindow().prepare(prepare(first, await request()));
        database.exec(
            "UPDATE message_parts SET data = json_set(data, '$.version', 999) WHERE type = 'context_compaction'"
        );
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
        expect(
            (await loadSessionHistory(1))
                .flatMap((message) => message.parts)
                .filter((part) => part.type === 'context_compaction')
        ).toEqual([]);
        const next = projector();
        await next.recordTurnStart(checkpoint());
        const rebuilt = await new ContextWindow().prepare(prepare(next, await request()));
        expect(JSON.stringify(rebuilt.messages)).toContain(summaryText);
    });

    it.each(['success', 'error', 'rejected', 'timeout'] as const)(
        'user reopens after a tool round with status %s was summarized and reuses the persisted checkpoint',
        async (status) => {
            const row = database
                .prepare(
                    "INSERT INTO messages (session_id, role) VALUES (1, 'tool_call') RETURNING id"
                )
                .get()!;
            await createToolPart('builtin', {
                message_id: Number(row.id),
                session_id: 1,
                tool_call_id: 'call-covered',
                tool_id: 'read_file',
                input: '{"path":"src/index.ts","lines":10}',
                output: 'Tool evidence '.repeat(300),
                status,
            });
            for (let i = 0; i < 8; i++) {
                const tail = database
                    .prepare('INSERT INTO messages (session_id, role) VALUES (1, ?) RETURNING id')
                    .get(i % 2 ? 'assistant' : 'user')!;
                database
                    .prepare(
                        "INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (?, 'text', ?, 0)"
                    )
                    .run(Number(tail.id), 'New evidence '.repeat(200));
            }
            const first = projector();
            await first.recordTurnStart(checkpoint());
            const live = await request();
            const toolResult = live.messages.find((message) => message.role === 'tool')!;
            toolResult.isError = status !== 'success';
            live.messages.find((message) => message.tool_calls?.length)!.tool_calls![0]!.arguments =
                '{\n "lines": 10, "path": "src/index.ts"\n}';
            const initial = await new ContextWindow().prepare(prepare(first, live));
            const saved = (await createSessionReadModel().getContext(1)).summary;
            expect(saved!.firstKeptMessageId).toBeGreaterThan(toolResult.contextSource!.id);
            const restored = await new ContextWindow().prepare({
                ...prepare(projector(), await request()),
                summarize: async () => {
                    throw new Error(
                        'Tool result must round-trip without invalidating the checkpoint'
                    );
                },
            });
            expect(restored.messages).toEqual(initial.messages);
        }
    );

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
                await new ContextWindow().prepare(prepare(first, await request()));
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
                expect(reopened.prepare('PRAGMA integrity_check').get()).toMatchObject({
                    integrity_check: 'ok',
                });
                const saved = (await createSessionReadModel().getContext(1)).summary;
                if (commit) {
                    expect(saved?.text).toBe(summaryText);
                    const result = await new ContextWindow().prepare({
                        ...prepare(projector(), await request()),
                        summarize: async () => {
                            throw new Error('Committed checkpoint must survive process exit');
                        },
                    });
                    expect(JSON.stringify(result.messages)).toContain(summaryText);
                } else {
                    expect(saved).toBeUndefined();
                    expect(await findMessagesBySessionId(1)).toHaveLength(25);
                }
                expect(
                    (await loadSessionHistory(1))
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
        await new ContextWindow().prepare(prepare(first, await request()));
        const saved = (await createSessionReadModel().getContext(1)).summary;
        const target = openMigratedDatabase();
        attachBackup(target, database);
        target.exec(readFileSync(resolve('src/database/artifacts/import/chat_merge.sql'), 'utf8'));
        routeQueriesTo(target);
        expect((await createSessionReadModel().getContext(1)).summary).toEqual(saved);
        expect((await loadSessionHistory(1)).slice(-1)[0]?.parts).toEqual([
            expect.objectContaining({
                type: 'context_compaction',
                state: 'compacted',
                id: saved!.id,
            }),
        ]);
        expect(target.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
});
