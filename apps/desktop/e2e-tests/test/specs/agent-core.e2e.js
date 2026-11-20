import assert from 'node:assert/strict';

import { getAgentFixture } from '../support/agent-fixture.js';
import {
    focusMain,
    submitPrompt,
    waitForAnswer as visible,
    waitForTurn as terminal,
} from '../support/agent-ui.js';
import { resetSearchSurface, useInterfaceLanguage, waitForE2eBridge } from '../support/desktop.js';
import { messageText, toolResultsAfterLatestPrompt } from '../support/model-provider.js';

async function send(prompt, answer) {
    await submitPrompt(prompt);
    await visible(answer);
    await terminal();
}
async function choose(label) {
    let selected;
    const armedAt = Date.now() + 500;
    await browser.waitUntil(
        async () => {
            const options = await $$('[data-testid="ask-user-panel"] [role="radio"]');
            for (const option of options) {
                if ((await option.isDisplayed()) && (await option.getText()).includes(label)) {
                    selected = option;
                    // The approval panel deliberately ignores activation during its 450ms arm delay.
                    return (
                        Date.now() >= armedAt &&
                        (await option.getAttribute('aria-disabled')) !== 'true'
                    );
                }
            }
            return false;
        },
        { timeoutMsg: `The user cannot choose ${label} in the question panel` }
    );
    await selected.click();
    await $('[data-testid="ask-user-panel"]').waitForExist({ reverse: true });
}
async function lastPromptCalls(prompt) {
    return getAgentFixture().provider.callsFor(prompt);
}

describe('user runs the production agent in the native application', () => {
    // Mocha hooks fail the run; WebdriverIO afterSession errors only log.
    after(async () => getAgentFixture().assertHealthy());

    afterEach(async function () {
        if (this.currentTest?.state === 'failed') {
            console.error(
                'Agent E2E visible state',
                await browser.execute(() => ({
                    text: document.body.innerText.slice(-7000),
                    focus: document.activeElement?.outerHTML.slice(0, 500),
                    modelPicker: document
                        .querySelector('[data-model-dropdown-popover="true"]')
                        ?.outerHTML.slice(0, 2000),
                    busy: document.querySelector('[role="log"]')?.getAttribute('aria-busy'),
                    panels: [...document.querySelectorAll('[data-testid="ask-user-panel"]')].map(
                        (panel) => panel.innerText
                    ),
                }))
            );
        }
    });

    before(async () => {
        await waitForE2eBridge();
        await useInterfaceLanguage();
        await focusMain();
    });

    it('user given a configured model when sending a prompt sees a durably saved answer', async () => {
        const fixture = getAgentFixture();
        await fixture.provider.respond('E2E first request', { answer: 'E2E first answer' });
        await send('E2E first request', 'E2E first answer');
        const rows = fixture.query(
            "SELECT m.role,p.content FROM message_parts p JOIN messages m ON m.id=p.message_id WHERE p.type='text'"
        );
        assert(
            rows.some((row) => row.role === 'user' && row.content.includes('E2E first request'))
        );
        assert(
            rows.some((row) => row.role === 'assistant' && row.content.includes('E2E first answer'))
        );
        assert.equal(
            fixture.query('SELECT status FROM session_turn_attempts ORDER BY id DESC LIMIT 1')[0]
                .status,
            'completed'
        );
    });

    it('user given prior history when asking for a setting receives a continued answer from the real tool result', async () => {
        const fixture = getAgentFixture();
        await fixture.provider.respond('E2E read setting', {
            tool: {
                name: 'builtin__setting',
                args: { action: 'get', keys: ['language'] },
                id: 'e2e-setting-read',
            },
            answer: 'E2E setting answer',
        });
        await send('E2E read setting', 'E2E setting answer');
        const requests = await lastPromptCalls('E2E read setting');
        assert.equal(requests.length, 2);
        assert(
            requests[0].messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    messageText(message).includes('E2E first answer')
            )
        );
        assert(
            toolResultsAfterLatestPrompt(requests[1]).some((result) =>
                result.output.includes('en-US')
            )
        );
        assert.equal(
            fixture.query('SELECT COUNT(DISTINCT session_id) AS count FROM session_turns')[0].count,
            1
        );
        assert(
            fixture
                .query("SELECT content,data FROM message_parts WHERE type!='text'")
                .some((row) => `${row.content}${row.data}`.includes('e2e-setting-read'))
        );
    });

    it('user given an agent question when choosing an option sends that answer through the tool and completes the turn', async () => {
        await resetSearchSurface();
        const fixture = getAgentFixture();
        await fixture.provider.respond('E2E ask a question', {
            tool: {
                name: 'builtin__ask_user_question',
                id: 'e2e-question',
                args: {
                    questions: [
                        {
                            header: 'Color',
                            question: 'Choose an E2E color',
                            options: [{ label: 'Amber' }, { label: 'Teal' }],
                        },
                    ],
                },
            },
            answer: 'E2E question answered',
        });
        await submitPrompt('E2E ask a question');
        await visible('Choose an E2E color');
        assert.equal((await lastPromptCalls('E2E ask a question')).length, 1);
        await choose('Teal');
        await visible('E2E question answered');
        await terminal();
        assert(
            toolResultsAfterLatestPrompt((await lastPromptCalls('E2E ask a question'))[1]).some(
                (result) => result.output.includes('Teal')
            )
        );
    });

    for (const approved of [false, true]) {
        it(`user given a pending setting change when ${approved ? 'approving' : 'rejecting'} it ${approved ? 'saves the setting once' : 'preserves the setting and returns the rejection'}`, async () => {
            await resetSearchSurface();
            const fixture = getAgentFixture();
            const name = approved ? 'approved' : 'rejected';
            const prompt = `E2E ${name} setting`;
            const readSetting = () =>
                fixture.query("SELECT value FROM settings WHERE key='start_minimized'")[0].value;
            const previous = readSetting();
            const requested = previous !== 'true';
            await fixture.provider.respond(prompt, {
                tool: {
                    name: 'builtin__setting',
                    id: `e2e-${name}`,
                    args: {
                        action: 'set',
                        key: 'start_minimized',
                        value: requested,
                        reason: 'Verify that a user controls the setting change',
                    },
                },
                answer: `E2E ${name} answer`,
            });
            await submitPrompt(prompt);
            await $('[data-testid="ask-user-panel"]').waitForDisplayed();
            assert.equal(readSetting(), previous, 'The setting changed before user approval');
            assert.equal((await lastPromptCalls(prompt)).length, 1);
            await choose(approved ? '\u6279\u51c6' : '\u62d2\u7edd');
            await visible(`E2E ${name} answer`);
            await terminal();
            assert.equal(readSetting(), approved ? String(requested) : previous);
            const audit = fixture.query(
                "SELECT json_extract(data, '$.status') AS status, json_extract(data, '$.approval_state') AS approval_state FROM message_parts WHERE type='tool_call' AND tool_call_id=?",
                `e2e-${name}`
            );
            assert.equal(audit.length, 1);
            assert.equal(audit[0].approval_state, approved ? 'approved' : 'rejected');
            assert.equal((await lastPromptCalls(prompt)).length, 2);
        });
    }

    it('user given streaming output when pressing Escape keeps cancellation despite late provider output', async () => {
        await resetSearchSurface();
        const fixture = getAgentFixture();
        // The service keeps writing after the turn is cancelled; these words must
        // never reach the UI or SQLite.
        await fixture.provider.respond('E2E cancel request', {
            answer: 'E2E cancellable partial E2E forbidden late answer',
            timing: { chunkDelayMs: [0, 0, 0, 3000, 0] },
        });
        await submitPrompt('E2E cancel request');
        await visible('E2E cancellable partial');
        await focusMain();
        await browser.keys(['Escape']);
        await terminal('cancelled');
        // A subsequent turn that outlives the late chunks gives them time to arrive, without a sleep.
        await fixture.provider.respond('E2E after cancellation', {
            answer: 'E2E still usable',
            timing: { ttftMs: 3500 },
        });
        await send('E2E after cancellation', 'E2E still usable');
        assert.equal(
            await browser.execute(() =>
                document.body.innerText.includes('E2E forbidden late answer')
            ),
            false
        );
        assert.equal(
            fixture.query(
                "SELECT COUNT(*) AS count FROM message_parts WHERE content LIKE '%E2E forbidden late answer%'"
            )[0].count,
            0
        );
        assert.equal(
            fixture.query("SELECT COUNT(*) AS count FROM session_turns WHERE status='cancelled'")[0]
                .count,
            1
        );
    });
    it('user given saved history when restarting and reopening the conversation retains its answer and next-turn context', async () => {
        const fixture = getAgentFixture();
        const [session] = fixture.query('SELECT id,title FROM sessions ORDER BY id LIMIT 1');
        const previousSession = browser.sessionId;
        await browser.reloadSession();
        assert.notEqual(browser.sessionId, previousSession);
        await waitForE2eBridge();
        await focusMain();
        await browser.keys(['Control', 'h']);
        const history = await $('[data-search-history-popover="true"]');
        await history.waitForDisplayed();
        await (await history.$('input')).setValue(session.title);
        let row;
        await browser.waitUntil(
            async () => {
                const matches = await history.$$('.history-session-row');
                row = matches.length === 1 ? matches[0] : undefined;
                return row && (await row.getText()).includes(session.title);
            },
            { timeoutMsg: 'Saved conversation did not appear after filtering history' }
        );
        await row.click();
        await visible('E2E first answer');
        await fixture.provider.respond('E2E after restart', {
            answer: 'E2E restored conversation',
        });
        await send('E2E after restart', 'E2E restored conversation');
        assert.equal(
            fixture.query('SELECT session_id FROM session_turns ORDER BY id DESC LIMIT 1')[0]
                .session_id,
            session.id
        );
        assert(
            (await lastPromptCalls('E2E after restart'))[0].messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    messageText(message).includes('E2E first answer')
            )
        );
    });

    it('user given two model connections when switching between them sends each request to only the selected connection', async () => {
        await resetSearchSurface();
        const fixture = getAgentFixture();
        for (const name of ['Beta', 'Alpha']) {
            await focusMain();
            const modelTrigger = await $('[data-testid="search-bar"] .logo-container');
            await modelTrigger.waitForDisplayed();
            await modelTrigger.waitForStable();
            await modelTrigger.click();
            const picker = await $('[data-model-dropdown-popover="true"]');
            await picker.waitForDisplayed();
            await (await picker.$('input')).setValue(`E2E ${name}`);
            await browser.waitUntil(
                () =>
                    browser.execute((label) => {
                        const rows = [
                            ...document.querySelectorAll(
                                '[data-model-dropdown-popover="true"] .model-dropdown-row'
                            ),
                        ];
                        return rows.length === 1 && rows[0].textContent.includes(label);
                    }, `E2E ${name}`),
                { timeoutMsg: `Model filter did not resolve E2E ${name}` }
            );
            await browser.keys('Enter');
            await picker.waitForExist({ reverse: true });
            const prompt = `E2E connection ${name}`;
            await fixture.provider.respond(prompt, { answer: `E2E answer from ${name}` });
            await send(prompt, `E2E answer from ${name}`);
            const requests = await lastPromptCalls(prompt);
            assert.equal(requests.length, 1);
            assert.equal(requests[0].path, `/v1/${name.toLowerCase()}/chat/completions`);
            assert.equal(requests[0].model, `e2e-${name.toLowerCase()}`);
        }
    });
});
