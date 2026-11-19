import { createToolPart } from '@database/queries/toolParts';
import { importChangedContextHistory } from '@tests/database/contextBackup';
import { routeQueriesTo } from '@tests/database/sqliteHarness';
import { createAgentWindowFixture, network, response } from '@tests/utils/agentWindow';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSessionTransportMessages } from '@/app/workflows/agent/historyTransport';
import { createSessionReadModel } from '@/modules/agent';

const summaryText =
    'Goal: fix the defect. Keep the archive. Pending approval: deployment. Next: verify.';
const prompt = 'Finish the work without deleting the archive.';
const answer = 'The archive remains intact.';
type WireMessage = {
    role: string;
    content?: unknown;
    tool_calls?: { id: string }[];
    tool_call_id?: string;
};

function messages(request: Record<string, unknown>): WireMessage[] {
    return request.messages as WireMessage[];
}
function summaryRequest(request: Record<string, unknown>): boolean {
    return JSON.stringify(messages(request).at(-1)?.content).includes(
        'Create a structured context checkpoint'
    );
}
function addHistory(database: ReturnType<typeof createAgentWindowFixture>['database'], count = 24) {
    for (let index = 0; index < count; index++) {
        const row = database
            .prepare('INSERT INTO messages (session_id, role) VALUES (1, ?) RETURNING id')
            .get(index % 2 ? 'assistant' : 'user')!;
        database
            .prepare(
                "INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (?, 'text', ?, 0)"
            )
            .run(Number(row.id), `Message ${index}: ${'evidence '.repeat(220)}`);
    }
}

let fixture: ReturnType<typeof createAgentWindowFixture>;
beforeEach(async () => {
    fixture = createAgentWindowFixture();
    await fixture.window.ready;
    await fixture.window.capabilities.waitForAgent();
    fixture.database
        .exec(`UPDATE models SET tool_call = 0, context_limit = 8000, output_limit = 1000;
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'context-test', 'Context test', 'fixture-model', 1);`);
    addHistory(fixture.database);
    network.respondToGeneration = async (_url, init) =>
        response(summaryRequest(JSON.parse(String(init.body))) ? summaryText : answer);
});
afterEach(async () => {
    await fixture.window.dispose();
});

async function run(options: { signal?: AbortSignal; providerId?: number; modelId?: string } = {}) {
    const task = await fixture.window.api.startTask({ sessionId: 1, prompt, ...options });
    return { task, result: await task.completion };
}

describe('given long committed history through the actual main execution entry', () => {
    it('user compacts and reopens under another model with the saved summary, original divider and retained request', async () => {
        const original = fixture.database
            .prepare('SELECT id, content FROM message_parts ORDER BY id')
            .all();
        const { result } = await run();
        expect(result.response).toBe(answer);
        const saved = (await createSessionReadModel().getContext(1)).summary;
        expect(saved).toMatchObject({ version: 2, text: summaryText });
        expect(
            fixture.database
                .prepare('SELECT id, content FROM message_parts WHERE id <= 24 ORDER BY id')
                .all()
        ).toEqual(original);
        const firstRequests = network.requests.length;
        fixture.database
            .exec(`INSERT INTO models (id, provider_id, name, model_id, tool_call, context_limit, output_limit)
            VALUES (2, 1, 'Another model', 'another-model', 0, 8000, 1000);`);
        const next = await run({ providerId: 1, modelId: 'another-model' });
        expect(next.result.model.modelId).toBe('another-model');
        expect(network.requests.at(-1)?.model).toBe('another-model');
        expect(network.requests.slice(firstRequests).some(summaryRequest)).toBe(false);
        const final = messages(network.requests.at(-1)!);
        expect(JSON.stringify(final)).toContain(summaryText);
        expect(final.at(-1)).toMatchObject({ role: 'user', content: prompt });
        expect(final.filter((message) => message.role === 'system')).not.toEqual([]);
        const { history } = await fixture.window.api.loadSession(1);
        expect(
            history
                .flatMap((message) => message.parts)
                .filter((part) => part.type === 'context_compaction')
        ).toHaveLength(1);
        expect(
            history
                .find((message) => message.parts.some((part) => part.type === 'context_compaction'))
                ?.parts.map((part) => part.type)
        ).toEqual(['context_compaction', 'text']);
        expect(JSON.stringify({ result, history })).not.toMatch(
            /fixture-secret|prompt_snapshot_json|checkpoint_json/
        );
    });

    it('user imports divergent history during summary generation and cannot commit a stale summary or start the answer', async () => {
        let imported = false;
        network.respondToGeneration = async (_url, init) => {
            if (!imported && summaryRequest(JSON.parse(String(init.body)))) {
                importChangedContextHistory(fixture.database);
                imported = true;
            }
            return response(summaryText);
        };
        await expect(run()).rejects.toMatchObject({ code: 'CONTEXT_COMPACTION_FAILED' });
        expect(network.requests.every(summaryRequest)).toBe(true);
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
        fixture.database.exec('DETACH DATABASE imported');
        network.respondToGeneration = async (_url, init) =>
            response(summaryRequest(JSON.parse(String(init.body))) ? summaryText : answer);
        expect((await run()).result.response).toBe(answer);
    });

    it('user continues a long tool conversation and updates one summary without splitting a call from its result', async () => {
        await run();
        const previous = network.requests.length;
        for (let index = 0; index < 14; index++) {
            const row = fixture.database
                .prepare(
                    "INSERT INTO messages (session_id, role) VALUES (1, 'tool_call') RETURNING id"
                )
                .get()!;
            await createToolPart('builtin', {
                message_id: Number(row.id),
                session_id: 1,
                tool_call_id: `new-${index}`,
                tool_id: 'read_file',
                input: '{}',
                output: 'New evidence '.repeat(350),
                status: 'success',
            });
        }
        const updated = `${summaryText} New tool evidence verified.`;
        network.respondToGeneration = async (_url, init) =>
            response(summaryRequest(JSON.parse(String(init.body))) ? updated : answer);
        await run();
        const updates = network.requests.slice(previous).filter(summaryRequest);
        expect(updates.length).toBeGreaterThan(0);
        expect(JSON.stringify(updates[0])).toContain(summaryText);
        const final = messages(network.requests.at(-1)!);
        expect(
            final
                .filter((message) => message.role === 'tool')
                .map((message) => message.tool_call_id)
        ).toEqual(final.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []));
        expect((await createSessionReadModel().getContext(1)).summary).toMatchObject({
            version: 2,
            text: updated,
        });
        expect(
            (await loadSessionTransportMessages({ sessionId: 1 })).filter(
                (message) => message.contextSummary
            )
        ).toHaveLength(1);
    });

    it('user exits after a summary commits before any answer and restores its divider and reported usage', async () => {
        const cancellation = new AbortController();
        let awaitingAnswer = false;
        network.respondToGeneration = async (_url, init) => {
            if (summaryRequest(JSON.parse(String(init.body)))) return response(summaryText);
            awaitingAnswer = true;
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                    once: true,
                });
            });
        };
        const pending = run({ signal: cancellation.signal });
        const failure = expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        await expect.poll(() => awaitingAnswer).toBe(true);
        const usage = fixture.database
            .prepare('SELECT input_tokens, llm_call_count FROM session_turns')
            .get();
        expect(usage?.llm_call_count).toBeGreaterThan(0);
        expect(Number(usage?.input_tokens)).toBeGreaterThan(0);
        cancellation.abort();
        await failure;
        expect((await createSessionReadModel().getContext(1)).summary).toMatchObject({
            text: summaryText,
        });
        expect(
            fixture.database.prepare('SELECT input_tokens, llm_call_count FROM session_turns').get()
        ).toEqual({
            input_tokens: usage?.input_tokens,
            llm_call_count: Number(usage?.llm_call_count) + 1,
        });
        expect(
            (await fixture.window.api.loadSession(1)).history
                .flatMap((message) => message.parts)
                .filter((part) => part.type === 'context_compaction')
        ).toMatchObject([{ state: 'compacted' }]);
    });

    it('user cancels summary generation without saving partial context and can run the same session again', async () => {
        const cancellation = new AbortController();
        network.respondToGeneration = async () => {
            cancellation.abort();
            return response(summaryText);
        };
        await expect(run({ signal: cancellation.signal })).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
        network.respondToGeneration = async (_url, init) =>
            response(summaryRequest(JSON.parse(String(init.body))) ? summaryText : answer);
        expect((await run()).result.response).toBe(answer);
    });

    it('user cancels as the summary barrier commits and reuses the fully durable summary without starting another answer', async () => {
        const cancellation = new AbortController();
        let cancelled = false;
        routeQueriesTo(fixture.database, {
            beforeCommit() {
                if (
                    !cancelled &&
                    fixture.database
                        .prepare("SELECT 1 FROM message_parts WHERE type = 'context_compaction'")
                        .get()
                ) {
                    cancelled = true;
                    cancellation.abort();
                }
            },
        });
        await expect(run({ signal: cancellation.signal })).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        expect(network.requests.every(summaryRequest)).toBe(true);
        expect((await createSessionReadModel().getContext(1)).summary).toMatchObject({
            text: summaryText,
        });
        const previous = network.requests.length;
        routeQueriesTo(fixture.database);
        expect((await run()).result.response).toBe(answer);
        expect(network.requests.slice(previous).some(summaryRequest)).toBe(false);
    });

    it('user receives a refused summary transaction without losing history and can retry after storage recovers', async () => {
        fixture.database.exec(`CREATE TEMP TRIGGER reject_compaction BEFORE INSERT ON message_parts
            WHEN NEW.type = 'context_compaction' BEGIN SELECT RAISE(ABORT, 'fixture compaction refusal'); END;`);
        await expect(run()).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
        expect(network.requests.every(summaryRequest)).toBe(true);
        expect(
            fixture.database
                .prepare(
                    "SELECT count(*) AS count FROM message_parts WHERE type = 'text' AND content LIKE 'Message %'"
                )
                .get()
        ).toEqual({ count: 24 });
        fixture.database.exec('DROP TRIGGER reject_compaction');
        expect((await run()).result.response).toBe(answer);
    });

    it('user ignores an unknown imported summary format and rebuilds safely from the original history', async () => {
        await run();
        fixture.database.exec(
            "UPDATE message_parts SET data = json_set(data, '$.version', 999) WHERE type = 'context_compaction'"
        );
        expect((await createSessionReadModel().getContext(1)).summary).toBeUndefined();
        const previous = network.requests.length;
        await run();
        expect(network.requests.slice(previous).some(summaryRequest)).toBe(true);
        expect((await createSessionReadModel().getContext(1)).summary).toMatchObject({
            version: 2,
            text: summaryText,
        });
    });

    it.each(['success', 'error', 'rejected', 'timeout'] as const)(
        'user reopens a summarized tool exchange with status %s and keeps a reusable checkpoint',
        async (status) => {
            const row = fixture.database
                .prepare(
                    "INSERT INTO messages (session_id, role) VALUES (1, 'tool_call') RETURNING id"
                )
                .get()!;
            await createToolPart('builtin', {
                message_id: Number(row.id),
                session_id: 1,
                tool_call_id: 'call-covered',
                tool_id: 'read_file',
                input: '{\n "lines": 10, "path": "src/index.ts"\n}',
                output: 'Tool evidence '.repeat(300),
                status,
            });
            addHistory(fixture.database, 8);
            await run();
            const saved = (await createSessionReadModel().getContext(1)).summary!;
            expect(saved.firstKeptMessageId).toBeGreaterThan(Number(row.id));
            const previous = network.requests.length;
            await run();
            expect(network.requests.slice(previous).some(summaryRequest)).toBe(false);
            expect((await createSessionReadModel().getContext(1)).summary).toEqual(saved);
        }
    );
});
