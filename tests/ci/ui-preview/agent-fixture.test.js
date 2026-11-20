import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createAgentFixture } from '../../../apps/desktop/e2e-tests/test/support/agent-fixture.js';
import { createMcpFixture } from '../../../apps/desktop/e2e-tests/test/support/mcp-fixture.js';
import { createModelProvider } from '../../../apps/desktop/e2e-tests/test/support/model-provider.js';

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
function request(fixture, messages) {
    return fetch(`${fixture.baseUrl}/alpha/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer e2e-alpha-key' },
        body: JSON.stringify({ model: 'e2e-alpha', stream: true, messages }),
    });
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
                'Model fixture received unexpected requests'
            );
        });
        fixture.provider.respond('expected', { answer: 'saved answer' });
        expect(
            await (await request(fixture.provider, [{ role: 'user', content: 'expected' }])).text()
        ).toContain('saved answer');
        const unexpected = await request(fixture.provider, [
            { role: 'user', content: 'unexpected' },
        ]);
        expect(unexpected.status).toBe(500);
        expect(() => fixture.assertHealthy()).toThrow('Model fixture received unexpected requests');
    });
    it('user receives a tool call followed by an answer when a real tool result returns', async () => {
        const fixture = await provider();
        fixture.respond('read setting', {
            tool: {
                name: 'builtin__setting',
                args: { action: 'get', keys: ['language'] },
                id: 'setting-1',
            },
            answer: 'saved result',
        });
        const messages = [{ role: 'user', content: 'read setting' }];
        expect(await (await request(fixture, messages)).text()).toContain('builtin__setting');
        expect(
            await (
                await request(fixture, [
                    ...messages,
                    { role: 'tool', tool_call_id: 'setting-1', content: 'en-US' },
                ])
            ).text()
        ).toContain('saved result');
        expect(fixture.requests[1].authorization).toBe('Bearer e2e-alpha-key');
        expect(fixture.errors).toEqual([]);
    });
    it('user gets a fresh tool call when an earlier turn already contains a tool result', async () => {
        const fixture = await provider();
        fixture.respond('new request', {
            tool: { name: 'builtin__setting', args: {} },
            answer: 'done',
        });
        const response = await request(fixture, [
            { role: 'user', content: 'old request' },
            { role: 'tool', content: 'old result' },
            { role: 'user', content: 'new request' },
        ]);
        expect(await response.text()).toContain('tool_calls');
    });
    it('user sees an explicit fixture failure when an unexpected model request arrives', async () => {
        const fixture = await provider();
        const response = await request(fixture, [{ role: 'user', content: 'unregistered' }]);
        expect(response.status).toBe(500);
        expect(fixture.errors).toHaveLength(1);
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
