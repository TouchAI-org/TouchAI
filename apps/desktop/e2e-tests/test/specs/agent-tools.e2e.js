import assert from 'node:assert/strict';

import { getAgentFixture } from '../support/agent-fixture.js';
import { focusMain, submitPrompt, waitForAnswer, waitForTurn } from '../support/agent-ui.js';
import {
    callE2eBridge,
    closeSettingsWindow,
    switchToWindowContaining,
    switchToWindowWithE2eBridge,
    useInterfaceLanguage,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';
import { createMcpFixture } from '../support/mcp-fixture.js';
import { toolResultsAfterLatestPrompt } from '../support/model-provider.js';

async function promptCalls(fixture, prompt) {
    return fixture.provider.callsFor(prompt);
}

function promptTurn(fixture, prompt) {
    const turns = fixture.query(
        `SELECT turn.* FROM session_turns AS turn
         JOIN message_parts AS part ON part.message_id = turn.prompt_message_id
         WHERE part.type = 'text' AND part.content = ?`,
        prompt
    );
    assert.equal(turns.length, 1, 'The submitted prompt must own exactly one persisted turn');
    return turns[0];
}

function attemptsFor(fixture, turnId) {
    return fixture.query(
        'SELECT * FROM session_turn_attempts WHERE turn_id = ? ORDER BY attempt_index',
        turnId
    );
}

function auditFor(fixture, mcp, callId) {
    const rows = fixture.query(
        `SELECT part.id, part.message_id, message.session_id, part.data
         FROM message_parts AS part JOIN messages AS message ON message.id = part.message_id
         WHERE part.type = 'tool_call' AND part.tool_kind = 'mcp'
           AND part.server_id = ? AND part.tool_call_id = ?`,
        mcp.serverId,
        callId
    );
    assert.equal(rows.length, 1, 'The MCP call must have one durable audit part');
    return { ...rows[0], data: JSON.parse(rows[0].data) };
}

async function waitForCatalog(fixture, mcp) {
    await browser.waitUntil(
        () => {
            mcp.assertHealthy();
            return (
                fixture.query(
                    `SELECT tool.name FROM mcp_tools AS tool
                     JOIN mcp_servers AS server ON server.id = tool.server_id
                     WHERE tool.server_id = ? AND tool.name = ? AND tool.enabled = 1
                       AND server.last_error IS NULL`,
                    mcp.serverId,
                    mcp.toolName
                ).length === 1
            );
        },
        {
            timeout: 20000,
            timeoutMsg: 'Connecting from Settings did not persist the real local MCP tool catalog',
        }
    );
}

async function connectInSettings(fixture, mcp) {
    const main = await browser.getWindowHandle();
    await callE2eBridge('openSettingsWindow');
    await switchToWindowContaining('/settings');
    await browser.execute(async () => {
        await window.__TAURI_INTERNALS__.invoke('plugin:window|set_focus', { label: 'settings' });
    });
    await (await waitForTestIdDisplayed('settings-nav-mcp-tools')).click();
    const heading = await $(`h3=${mcp.serverName}`);
    await heading.waitForDisplayed();
    await heading.click();
    const connect = await $('button=Connect');
    await connect.waitForEnabled();
    await connect.click();
    await waitForCatalog(fixture, mcp);
    await closeSettingsWindow();
    await switchToWindowWithE2eBridge(main);
    await focusMain();
}

async function openToolResult(mcp) {
    const buttons = await $$('.tool-call-toggle');
    for (const button of buttons) {
        const text = await button.getProperty('textContent');
        if (!text.includes(mcp.toolName)) continue;
        await button.scrollIntoView();
        await button.waitForDisplayed();
        if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
        return;
    }
    assert.fail(
        `The conversation did not render the MCP tool card: ${await browser.execute(() => document.body.innerText)}`
    );
}

describe('user has a native agent with an isolated local MCP server', function () {
    // Mocha hooks fail the run; WebdriverIO afterSession errors only log.
    after(async () => getAgentFixture().assertHealthy());

    this.timeout(90000);
    let fixture;
    let mcp;

    beforeEach(async () => {
        fixture = getAgentFixture();
        await waitForE2eBridge();
        await useInterfaceLanguage();
        mcp = await createMcpFixture(fixture);
        await browser.reloadSession();
        await waitForE2eBridge();
        await connectInSettings(fixture, mcp);
    });

    afterEach(async () => {
        if (!mcp) return;
        try {
            await mcp.close();
        } finally {
            mcp = undefined;
        }
    });

    it('user given a saved tool result when the model fails once receives the answer without repeating the effect', async () => {
        const marker = `mcp-retry-${mcp.serverId}`;
        const prompt = `E2E record the MCP retry marker ${marker}`;
        const callId = `call-${marker}`;
        const answer = `E2E MCP retry completed ${marker}`;
        await fixture.provider.script([
            {
                id: 'mcp-tool',
                match: {
                    textContains: prompt,
                    tool: mcp.namespacedName,
                },
                times: 1,
                reply: [
                    {
                        type: 'tool_call',
                        name: mcp.namespacedName,
                        arguments: { marker },
                        id: callId,
                    },
                ],
            },
            {
                id: 'mcp-failure',
                match: { textContains: prompt, hasToolResult: true },
                times: 1,
                error: {
                    status: 503,
                    message: 'E2E transient failure after the committed MCP result',
                },
            },
            {
                id: 'mcp-answer',
                match: { textContains: prompt, hasToolResult: true },
                reply: [{ type: 'text', text: answer }],
            },
        ]);

        await submitPrompt(prompt);
        await waitForAnswer(answer);
        await waitForTurn();
        mcp.assertHealthy();

        const turn = promptTurn(fixture, prompt);
        assert.equal(turn.status, 'completed');
        assert.deepEqual(
            attemptsFor(fixture, turn.id).map((attempt) => attempt.status),
            ['failed', 'completed'],
            'The real Core retry must be durable, with a failed and a completed attempt'
        );
        const audit = auditFor(fixture, mcp, callId);
        assert.equal(audit.session_id, turn.session_id);
        assert.equal(audit.data.status, 'success');
        assert.equal(audit.data.tool_name, mcp.toolName);
        assert.equal(JSON.parse(audit.data.input).marker, marker);
        assert(audit.data.output.includes(mcp.resultFor(marker)));
        assert.equal(mcp.effectsFor(marker).length, 1, 'A retry must not repeat the remote effect');

        const requests = await promptCalls(fixture, prompt);
        assert.equal(requests.length, 3, 'One tool request, one failed continuation, one retry');
        assert(
            requests[0].tools.includes(mcp.namespacedName),
            'Models must offer the catalog tool discovered by the native MCP client'
        );
        assert.equal(toolResultsAfterLatestPrompt(requests[0]).length, 0);
        const [toolResult] = toolResultsAfterLatestPrompt(requests[1]);
        assert.equal(toolResultsAfterLatestPrompt(requests[1]).length, 1);
        assert.equal(toolResult.id, callId);
        assert(toolResult.output.includes(mcp.resultFor(marker)));
        assert.equal(requests[1].status, 503);
        assert.deepEqual(
            toolResultsAfterLatestPrompt(requests[2]),
            toolResultsAfterLatestPrompt(requests[1])
        );
        assert(
            fixture.query(
                `SELECT part.content FROM message_parts AS part
             JOIN messages AS message ON message.id = part.message_id
             WHERE message.session_id = ? AND message.role = 'assistant'
               AND part.type = 'text' AND part.content = ?`,
                turn.session_id,
                answer
            ).length === 1,
            'The answer shown in the UI must also survive in SQLite'
        );
        await openToolResult(mcp);
        await waitForAnswer(mcp.resultFor(marker));
    });

    it('user given a connection lost after an effect when submitting a prompt sees failure without a blind replay and can recover', async () => {
        const marker = `mcp-disconnect-${mcp.serverId}`;
        const prompt = `E2E record the MCP disconnect marker ${marker}`;
        const callId = `call-${marker}`;
        mcp.injectOnce({ kind: 'disconnect', marker, callId });
        await fixture.provider.respond(prompt, {
            tool: { name: mcp.namespacedName, args: { marker }, id: callId },
            answer: 'E2E unexpected continuation after an uncertain effect',
        });

        await submitPrompt(prompt);
        await waitForAnswer('Request failed: SIDE_EFFECT_UNCERTAIN');
        await waitForTurn('failed');
        mcp.assertHealthy();

        const turn = promptTurn(fixture, prompt);
        assert.equal(turn.status, 'failed');
        assert.equal(turn.error_message, 'SIDE_EFFECT_UNCERTAIN');
        assert.equal(attemptsFor(fixture, turn.id).length, 1);
        const audit = auditFor(fixture, mcp, callId);
        assert.equal(audit.data.status, 'error');
        assert(
            audit.data.error_message?.length > 0,
            'The failed audit must explain the MCP failure'
        );
        assert.equal(mcp.faultState().disconnected, true, 'The real HTTP socket must be closed');
        assert.equal(mcp.effectsFor(marker).length, 1);
        assert.equal((await promptCalls(fixture, prompt)).length, 1);
        await openToolResult(mcp);
        await waitForAnswer(audit.data.output);

        mcp.clearCatalog();
        await browser.reloadSession();
        await waitForE2eBridge();
        await connectInSettings(fixture, mcp);
        await recoverWithNewEffect('disconnect');
        assert.equal(
            mcp.effectsFor(marker).length,
            1,
            'Reconnection must not replay the old effect'
        );
        assert.equal((await promptCalls(fixture, prompt)).length, 1);
    });

    it('user given a completed effect when saving its audit fails sees a save error without replay and can submit a fresh prompt', async () => {
        const marker = `mcp-save-failure-${mcp.serverId}`;
        const prompt = `E2E record the MCP save failure marker ${marker}`;
        const callId = `call-${marker}`;
        mcp.injectOnce({ kind: 'write-lock', marker, callId });
        await fixture.provider.respond(prompt, {
            tool: { name: mcp.namespacedName, args: { marker }, id: callId },
            answer: 'E2E forbidden success after an unsaved effect',
        });

        await submitPrompt(prompt);
        try {
            await waitForAnswer('Request failed: Save failed');
            mcp.assertHealthy();
            const fault = mcp.faultState();
            assert(fault.lockHeld, 'The user must see the failure while SQLite is still locked');
            assert(
                fault.resultSent,
                'The MCP server must send the success before the save failure'
            );
            assert.equal(fault.pendingAuditStatus, 'pending');
            assert.equal(fault.watchdogReleased, false);
            const turn = promptTurn(fixture, prompt);
            assert.notEqual(turn.status, 'completed');
            assert.equal(attemptsFor(fixture, turn.id).length, 1);
            const audit = auditFor(fixture, mcp, callId);
            assert.equal(audit.data.status, 'pending');
            assert(!audit.data.output, 'An unsaved MCP result must not be acknowledged as durable');
            assert.equal(mcp.effectsFor(marker).length, 1);
            assert.equal((await promptCalls(fixture, prompt)).length, 1);
        } finally {
            mcp.releaseWriteLock();
        }

        await recoverWithNewEffect('save-failure');
        assert.equal(mcp.effectsFor(marker).length, 1, 'Unlocking must not replay the old effect');
        assert.equal((await promptCalls(fixture, prompt)).length, 1);
        assert.notEqual(auditFor(fixture, mcp, callId).data.status, 'success');
    });

    async function recoverWithNewEffect(reason) {
        const marker = `mcp-recovery-${reason}-${mcp.serverId}`;
        const prompt = `E2E record a fresh MCP recovery marker ${marker}`;
        const callId = `call-${marker}`;
        const answer = `E2E MCP recovered ${marker}`;
        await fixture.provider.respond(prompt, {
            tool: { name: mcp.namespacedName, args: { marker }, id: callId },
            answer,
        });
        await submitPrompt(prompt);
        await waitForAnswer(answer);
        await waitForTurn();
        mcp.assertHealthy();
        assert.equal(promptTurn(fixture, prompt).status, 'completed');
        assert.equal(auditFor(fixture, mcp, callId).data.status, 'success');
        assert.equal(mcp.effectsFor(marker).length, 1);
        assert.equal((await promptCalls(fixture, prompt)).length, 2);
    }
});
