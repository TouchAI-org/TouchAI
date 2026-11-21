import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TOOL_NAME = 'record_effect';
const AWAITING_CATALOG = 'Awaiting native MCP catalog';
const LOCK_WATCHDOG_MS = 45000;
const MAX_EFFECTS = 16;

export async function createMcpFixture(fixture) {
    const [{ Server }, { StreamableHTTPServerTransport }, schemas] = await Promise.all([
        import('@modelcontextprotocol/sdk/server/index.js'),
        import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
        import('@modelcontextprotocol/sdk/types.js'),
    ]).catch((cause) => {
        throw new Error(
            'Native MCP E2E requires the Desktop development dependencies; run pnpm install --frozen-lockfile',
            { cause }
        );
    });
    const appRoot = realpathSync(fixture.appRoot);
    const databasePath = realpathSync(fixture.databasePath);
    const relativeDatabase = path.relative(appRoot, databasePath);
    assert(
        relativeDatabase &&
            !relativeDatabase.startsWith('..') &&
            !path.isAbsolute(relativeDatabase),
        'The MCP fixture may lock only the isolated database inside the agent fixture appRoot'
    );
    const directory = mkdtempSync(path.join(appRoot, 'mcp-fixture-'));
    const ledgerPath = path.join(directory, 'effects.jsonl');
    const serverName = `MCP fixture ${path.basename(directory)}`;
    writeFileSync(ledgerPath, '');

    const errors = [];
    const sockets = new Set();
    const protocols = new Set();
    const closingProtocols = new Set();
    let serverId;
    let closed = false;
    let injectedFault;
    let lockDatabase;
    let watchdog;
    let effectCount = 0;
    const observed = {
        applied: false,
        disconnected: false,
        pendingAuditStatus: undefined,
        resultSent: false,
        watchdogReleased: false,
    };
    const resultFor = (marker) => `MCP effect recorded: ${marker}`;

    function assertHealthy() {
        if (errors.length) throw new AggregateError([...errors], 'Local MCP fixture failed');
    }

    function releaseWriteLock() {
        clearTimeout(watchdog);
        watchdog = undefined;
        if (!lockDatabase) return;
        const database = lockDatabase;
        lockDatabase = undefined;
        try {
            database.exec('ROLLBACK');
        } finally {
            database.close();
        }
    }

    function acquireWriteLock() {
        const database = new DatabaseSync(databasePath);
        try {
            database.exec('PRAGMA busy_timeout=0');
            database.exec('BEGIN IMMEDIATE');
            lockDatabase = database;
        } catch (error) {
            database.close();
            throw new Error('Could not acquire the post-effect SQLite write lock', {
                cause: error,
            });
        }
        watchdog = setTimeout(() => {
            observed.watchdogReleased = true;
            errors.push(
                new Error('SQLite fault watchdog expired before the UI acknowledged failure')
            );
            try {
                releaseWriteLock();
            } catch (error) {
                errors.push(error);
            }
        }, LOCK_WATCHDOG_MS);
        watchdog.unref();
    }

    function closeProtocol(protocol) {
        if (!protocols.delete(protocol)) return;
        const closing = protocol.close().catch((error) => errors.push(error));
        closingProtocols.add(closing);
        void closing.then(() => closingProtocols.delete(closing));
    }

    const http = createServer(async (request, response) => {
        if (request.url !== '/mcp') {
            response.writeHead(404).end();
            return;
        }
        const protocol = new Server(
            { name: serverName, version: '1.0.0' },
            { capabilities: { tools: {} } }
        );
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        let disconnectedThisRequest = false;
        let returnedLockedResult = false;
        protocols.add(protocol);
        response.once('close', () => closeProtocol(protocol));
        response.once('finish', () => {
            if (returnedLockedResult) observed.resultSent = true;
        });
        protocol.setRequestHandler(schemas.ListToolsRequestSchema, async () => ({
            tools: [
                {
                    name: TOOL_NAME,
                    description: 'Record one local E2E marker and return its receipt.',
                    inputSchema: {
                        type: 'object',
                        properties: { marker: { type: 'string', minLength: 1, maxLength: 160 } },
                        required: ['marker'],
                        additionalProperties: false,
                    },
                },
            ],
        }));
        protocol.setRequestHandler(schemas.CallToolRequestSchema, async ({ params }) => {
            try {
                assert.equal(
                    params.name,
                    TOOL_NAME,
                    'The local MCP server received an unknown tool'
                );
                const { marker, ...extra } = params.arguments ?? {};
                assert.equal(typeof marker, 'string');
                assert(marker.length > 0 && marker.length <= 160);
                assert.equal(Object.keys(extra).length, 0);
                assert(
                    effectCount < MAX_EFFECTS,
                    'The MCP fixture detected an unbounded effect loop'
                );
                const applyFault = injectedFault?.marker === marker && !observed.applied;
                if (applyFault) {
                    const audit = fixture.query(
                        `SELECT data FROM message_parts WHERE type = 'tool_call'
                         AND tool_kind = 'mcp' AND server_id = ? AND tool_call_id = ?`,
                        serverId,
                        injectedFault.callId
                    );
                    assert.equal(
                        audit.length,
                        1,
                        'The fault must follow a real Tools audit admission'
                    );
                    observed.pendingAuditStatus = JSON.parse(audit[0].data).status;
                    assert.equal(observed.pendingAuditStatus, 'pending');
                    observed.applied = true;
                }
                appendFileSync(
                    ledgerPath,
                    `${JSON.stringify({ marker, result: resultFor(marker) })}\n`
                );
                effectCount++;
                if (applyFault && injectedFault.kind === 'write-lock') {
                    acquireWriteLock();
                    returnedLockedResult = true;
                }
                if (applyFault && injectedFault.kind === 'disconnect') {
                    disconnectedThisRequest = true;
                    observed.disconnected = true;
                    for (const socket of sockets) socket.destroy();
                }
                return { content: [{ type: 'text', text: resultFor(marker) }], isError: false };
            } catch (error) {
                errors.push(error);
                throw error;
            }
        });
        try {
            await protocol.connect(transport);
            await transport.handleRequest(request, response);
        } catch (error) {
            if (!disconnectedThisRequest) errors.push(error);
            if (!response.headersSent && !response.destroyed) response.writeHead(500);
            response.end();
            closeProtocol(protocol);
        }
    });
    http.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });

    async function close() {
        if (closed) return;
        closed = true;
        try {
            releaseWriteLock();
        } catch (error) {
            errors.push(error);
        }
        for (const socket of sockets) socket.destroy();
        for (const protocol of protocols) closeProtocol(protocol);
        await Promise.all([...closingProtocols]);
        if (http.listening) await new Promise((resolve) => http.close(resolve));
        if (serverId !== undefined) {
            try {
                fixture.execute('DELETE FROM mcp_tools WHERE server_id = ?', serverId);
                fixture.execute('DELETE FROM mcp_servers WHERE id = ?', serverId);
            } catch (error) {
                errors.push(error);
            }
        }
        assertHealthy();
    }

    try {
        await new Promise((resolve, reject) => {
            http.once('error', reject);
            http.listen(0, '127.0.0.1', resolve);
        });
        const url = `http://127.0.0.1:${http.address().port}/mcp`;
        const inserted = fixture.execute(
            `INSERT INTO mcp_servers (name, transport_type, url, enabled, tool_timeout, last_error)
             VALUES (?, 'http', ?, 1, 5000, ?)`,
            serverName,
            url,
            AWAITING_CATALOG
        );
        serverId = Number(inserted.lastInsertRowid);
        assert(Number.isSafeInteger(serverId) && serverId > 0);
        return {
            serverId,
            serverName,
            toolName: TOOL_NAME,
            namespacedName: `mcp__${serverId}__${TOOL_NAME}`,
            ledgerPath,
            resultFor,
            effectsFor: (marker) =>
                readFileSync(ledgerPath, 'utf8')
                    .split('\n')
                    .filter(Boolean)
                    .map((line) => JSON.parse(line))
                    .filter((entry) => entry.marker === marker),
            injectOnce(fault) {
                assert(
                    !injectedFault,
                    'Only one transport or persistence fault is allowed per fixture'
                );
                assert(['disconnect', 'write-lock'].includes(fault.kind));
                assert.equal(typeof fault.marker, 'string');
                assert.equal(typeof fault.callId, 'string');
                injectedFault = { ...fault };
            },
            faultState: () => ({ ...observed, lockHeld: Boolean(lockDatabase) }),
            clearCatalog() {
                fixture.execute('DELETE FROM mcp_tools WHERE server_id = ?', serverId);
                fixture.execute(
                    'UPDATE mcp_servers SET last_error = ? WHERE id = ?',
                    AWAITING_CATALOG,
                    serverId
                );
            },
            releaseWriteLock,
            assertHealthy,
            close,
        };
    } catch (error) {
        try {
            await close();
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'MCP setup and cleanup failed', {
                cause: cleanupError,
            });
        }
        throw error;
    }
}
