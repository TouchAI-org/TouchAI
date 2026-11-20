import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentFixture } from '../../../apps/desktop/e2e-tests/test/support/agent-fixture.js';
import { createMcpFixture } from '../../../apps/desktop/e2e-tests/test/support/mcp-fixture.js';
import {
    createModelProvider,
    toolResultsAfterLatestPrompt,
} from '../../../apps/desktop/e2e-tests/test/support/model-provider.js';

const desktopRequire = createRequire(
    new URL('../../../apps/desktop/package.json', import.meta.url)
);
const cleanups = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function provider() {
    const fixture = await createModelProvider();
    cleanups.push(() => fixture.close());
    return fixture;
}
function request(fixture, messages, extra = {}) {
    return fetch(`${fixture.baseUrl}/alpha/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer e2e-alpha-key' },
        body: JSON.stringify({ model: 'e2e-alpha', stream: true, messages, ...extra }),
    });
}

const settingTool = {
    type: 'function',
    function: {
        name: 'builtin__setting',
        description: 'Read or write one setting.',
        parameters: { type: 'object', properties: { action: { type: 'string' } } },
    },
};

function streamedFrames(body) {
    return body
        .split('\n')
        .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {});
}

function streamedText(body) {
    return streamedFrames(body)
        .map((delta) => delta.content ?? '')
        .join('');
}

function streamedFinishReasons(body) {
    return body
        .split('\n')
        .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
        .map((line) => JSON.parse(line.slice(6)).choices?.[0]?.finish_reason)
        .filter(Boolean);
}

describe('user runs isolated native agent regressions', () => {
    it('user gets a current isolated database when the native fixture starts', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-agent-fixture-'));
        cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
        const fixture = await createAgentFixture(directory);
        cleanups.push(() => fixture.close());
        expect(fixture.query('SELECT COUNT(*) AS count FROM migrations')[0].count).toBeGreaterThan(
            0
        );
        expect(fixture.query('SELECT name FROM models WHERE is_default=1')).toEqual([
            { name: 'E2E Alpha' },
        ]);
        expect(
            fixture.query('SELECT name FROM providers WHERE enabled=1').map((row) => row.name)
        ).toEqual(['E2E Alpha', 'E2E Beta']);
        const db = new DatabaseSync(fixture.databasePath);
        try {
            expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
        } finally {
            db.close();
        }
    });
    it('user sees failed acceptance when an unexpected model request follows a successful answer', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-agent-errors-'));
        cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
        const fixture = await createAgentFixture(directory);
        cleanups.push(async () => {
            await expect(fixture.close()).rejects.toThrow(
                'The model service answered an unscripted request'
            );
        });
        await fixture.provider.respond('expected', { answer: 'saved answer' });
        const answered = await request(fixture.provider, [{ role: 'user', content: 'expected' }]);
        expect(streamedText(await answered.text())).toBe('saved answer');
        const unexpected = await request(fixture.provider, [
            { role: 'user', content: 'never scripted' },
        ]);
        expect(unexpected.status).toBe(400);
        await expect(fixture.assertHealthy()).rejects.toThrow(
            'The model service answered an unscripted request'
        );
    });
    it('user receives a tool call followed by an answer when a real tool result returns', async () => {
        const fixture = await provider();
        await fixture.respond('read setting', {
            tool: {
                name: 'builtin__setting',
                args: { action: 'get', keys: ['language'] },
                id: 'setting-1',
            },
            answer: 'saved result',
        });
        const messages = [{ role: 'user', content: 'read setting' }];
        const toolDeltas = streamedFrames(
            await (await request(fixture, messages, { tools: [settingTool] })).text()
        );
        expect(
            toolDeltas.flatMap((delta) => delta.tool_calls ?? []).map((call) => call.function?.name)
        ).toContain('builtin__setting');

        const answerResponse = await request(
            fixture,
            [
                ...messages,
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'setting-1',
                            type: 'function',
                            function: {
                                name: 'builtin__setting',
                                arguments: JSON.stringify({ action: 'get', keys: ['language'] }),
                            },
                        },
                    ],
                },
                { role: 'tool', tool_call_id: 'setting-1', content: 'en-US' },
            ],
            { tools: [settingTool] }
        );
        expect(streamedText(await answerResponse.text())).toBe('saved result');

        const calls = await fixture.calls();
        expect(calls).toHaveLength(2);
        expect(calls[1].path).toBe('/v1/alpha/chat/completions');
        expect(toolResultsAfterLatestPrompt(calls[1])).toEqual([
            { type: 'tool_result', id: 'setting-1', output: 'en-US' },
        ]);
    });
    it('user gets a fresh tool call when an earlier turn already contains a tool result', async () => {
        const fixture = await provider();
        await fixture.respond('new request', {
            tool: { name: 'builtin__setting', args: {} },
            answer: 'done',
        });
        const response = await request(
            fixture,
            [
                { role: 'user', content: 'old request' },
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [
                        {
                            id: 'old-call',
                            type: 'function',
                            function: { name: 'builtin__setting', arguments: '{}' },
                        },
                    ],
                },
                { role: 'tool', tool_call_id: 'old-call', content: 'old result' },
                { role: 'user', content: 'new request' },
            ],
            { tools: [settingTool] }
        );
        const body = await response.text();
        const deltas = streamedFrames(body);
        expect(
            deltas.flatMap((delta) => delta.tool_calls ?? []).map((call) => call.function?.name)
        ).toContain('builtin__setting');
        expect(streamedFinishReasons(body)).toContain('tool_calls');
    });
    it('user sees an explicit fixture failure when an unexpected model request arrives', async () => {
        const fixture = await provider();
        const response = await request(fixture, [{ role: 'user', content: 'unregistered' }]);
        expect(response.status).toBe(400);
        await expect(fixture.assertHealthy()).rejects.toThrow(
            'The model service answered an unscripted request'
        );
    });
});

describe('user connects the real local MCP fixture', () => {
    it('user gets a protocol handshake, tool catalog and one recorded effect through HTTP', async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-mcp-fixture-'));
        cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
        const fixture = await createAgentFixture(directory);
        cleanups.push(() => fixture.close());
        const mcp = await createMcpFixture(fixture);
        cleanups.push(() => mcp.close());
        const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
            import(
                pathToFileURL(desktopRequire.resolve('@modelcontextprotocol/sdk/client/index.js'))
                    .href
            ),
            import(
                pathToFileURL(
                    desktopRequire.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')
                ).href
            ),
        ]);
        const client = new Client({ name: 'touchai-e2e-fixture-check', version: '1.0.0' });
        cleanups.push(() => client.close());
        const [server] = fixture.query('SELECT url FROM mcp_servers WHERE id=?', mcp.serverId);
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([mcp.toolName]);
        const result = await client.callTool({
            name: mcp.toolName,
            arguments: { marker: 'fixture-check' },
        });
        expect(result.content).toEqual([{ type: 'text', text: mcp.resultFor('fixture-check') }]);
        expect(mcp.effectsFor('fixture-check')).toHaveLength(1);
        mcp.assertHealthy();
    });
});
