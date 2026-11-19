import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { createAgentStreamServer, deferred } from '../support/agent-stream.js';
import {
    clickMessageAction,
    dragQueuedMessage,
    fillSearchDraft,
    loadingMessage,
    messageByText,
    pendingMessages,
    pressEditorKey,
    readConversationMessages,
    submitSearchDraft,
    waitForConversation,
} from '../support/conversation-queue.js';
import {
    assertVisible,
    callE2eBridge,
    resetSearchSurface,
    useInterfaceLanguage,
    waitForE2eBridge,
} from '../support/desktop.js';
import { configureE2eModel } from '../support/model-administration.js';

async function sendPrompt(text) {
    await fillSearchDraft(text);
    await submitSearchDraft('enter');
}

async function queuePrompt(text, count) {
    await sendPrompt(text);
    return waitForConversation(
        (state) =>
            pendingMessages(state).length === count &&
            messageByText(state, text)?.pendingDelivery === 'queue',
        `The queue did not accept ${JSON.stringify(text)}.`
    );
}

async function openHistorySession(prompt) {
    await pressEditorKey('h', { modified: true });
    const search = await $('[data-search-history-popover] input');
    await search.waitForDisplayed();
    await search.setValue(prompt);
    const row = await $(`button.history-session-row*=${prompt}`);
    await row.waitForClickable();
    await row.click();
    await browser.waitUntil(async () => !(await $('[data-search-history-popover]').isDisplayed()), {
        timeoutMsg: 'Selecting a history session did not close history.',
    });
    await waitForConversation(
        (state) => Boolean(messageByText(state, prompt)),
        `History did not restore the session beginning with ${JSON.stringify(prompt)}.`
    );
}

function assertUserTurns(request, expected) {
    assertVisible(
        JSON.stringify(request.userTexts) === JSON.stringify(expected),
        `Expected model user turns ${JSON.stringify(expected)}, received ${JSON.stringify(request.userTexts)}.`
    );
}

async function readRows(sql, params = []) {
    return browser.execute(
        async (query, values) => {
            const result = await window.__TAURI_INTERNALS__.invoke('database_query', {
                request: { sql: query, params: values, method: 'all' },
            });
            return result.rows;
        },
        sql,
        params
    );
}

async function sessionIdForPrompt(prompt) {
    const rows = await readRows(
        'SELECT id FROM sessions WHERE title = ? ORDER BY id DESC LIMIT 1',
        [prompt]
    );
    assertVisible(rows.length === 1, 'The submitted conversation was not persisted.');
    return rows[0].id;
}

async function waitForDurableQueue(sessionId, texts) {
    let rows;
    await browser.waitUntil(
        async () => {
            rows = await readRows(
                'SELECT id, prompt FROM session_pending_messages WHERE session_id = ? ORDER BY position, id',
                [sessionId]
            );
            return JSON.stringify(rows.map((row) => row.prompt)) === JSON.stringify(texts);
        },
        { timeoutMsg: `The durable queue did not become ${JSON.stringify(texts)}.` }
    );
    return rows;
}

function desktopProcessIds(application) {
    if (process.platform === 'win32') {
        const executable = application.replaceAll("'", "''");
        const output = execFileSync(
            'powershell.exe',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executable}' } | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`,
            ],
            { encoding: 'utf8', timeout: 15000 }
        ).trim();
        const ids = output ? JSON.parse(output) : [];
        return Array.isArray(ids) ? ids : [ids];
    }

    const executable = fs.realpathSync(application);
    return fs
        .readdirSync('/proc')
        .filter((entry) => {
            if (!/^\d+$/.test(entry)) return false;
            try {
                return fs.readlinkSync(`/proc/${entry}/exe`) === executable;
            } catch {
                return false;
            }
        })
        .map(Number);
}

async function restartApplication() {
    const application = browser.requestedCapabilities['tauri:options'].application;
    const previousIds = desktopProcessIds(application);
    const previousSession = browser.sessionId;
    await browser.reloadSession();
    assertVisible(
        browser.sessionId !== previousSession,
        'The driver reused the old application session.'
    );
    let currentIds;
    await browser.waitUntil(
        () => {
            currentIds = desktopProcessIds(application);
            const stopped = previousIds.filter((id) => !currentIds.includes(id));
            const started = currentIds.filter((id) => !previousIds.includes(id));
            return stopped.length === 1 && started.length === 1;
        },
        {
            timeout: 30000,
            timeoutMsg: 'Restarting the driver did not replace exactly one native TouchAI process.',
        }
    );
    console.info(
        `[queue restart] native processes ${JSON.stringify(previousIds)} -> ${JSON.stringify(currentIds)}`
    );
    await waitForE2eBridge(30000);
}

describe('user keeps queued work across session changes and interruptions', () => {
    let server;

    before(async () => {
        server = await createAgentStreamServer();
        await waitForE2eBridge();
        await useInterfaceLanguage();
        await resetSearchSurface();
        await configureE2eModel(server.endpoint, server.modelId, 'TouchAI E2E Model');
    });

    beforeEach(async () => {
        await callE2eBridge('clearPendingSearchMessages');
        await callE2eBridge('cancelSearchRequest');
        await resetSearchSurface();
        await callE2eBridge('setSearchKeybindings', {
            'search.submit.queue': 'Enter',
            'search.submit.priority': 'Mod+Enter',
            'search.history.open': 'Mod+H',
            'search.session.new': 'Mod+N',
        });
        server.reset();
    });

    afterEach(async () => {
        await callE2eBridge('clearPendingSearchMessages');
        await callE2eBridge('cancelSearchRequest');
        await resetSearchSurface();
        assertVisible(
            server.protocolError === null,
            `The local model server failed: ${server.protocolError}`
        );
        server.reset();
    });

    after(async () => {
        await server.close();
    });

    it('user starts another conversation and returns through history without mixing either session or its queue', async () => {
        const firstSession = 'Session A queue isolation';
        const secondSession = 'Session B independent conversation';
        const queues = ['Session A queued one', 'Session A queued two'];
        const finishFirst = deferred();
        const finishQueue = deferred();
        server.planNext(async ({ stream }) => {
            stream.text('Session A is still working.');
            await finishFirst.promise;
            stream.finish();
        });
        server.planNext(({ stream }) => {
            stream.text('Session B answer.');
            stream.finish();
        });
        server.planNext(async ({ stream }) => {
            stream.text('Session A first queued answer.');
            await finishQueue.promise;
            stream.finish();
        });
        server.planNext(({ stream }) => {
            stream.text('Session A second queued answer.');
            stream.finish();
        });

        await sendPrompt(firstSession);
        await server.waitForRequestCount(1);
        await waitForConversation(
            (state) => Boolean(loadingMessage(state)),
            'Session A did not start.'
        );
        await queuePrompt(queues[0], 1);
        await queuePrompt(queues[1], 2);
        await pressEditorKey('n', { modified: true });
        await browser.waitUntil(
            async () => !(await $('[data-testid="conversation-panel-host"]').isDisplayed()),
            { timeoutMsg: 'The new-session shortcut did not open an empty conversation.' }
        );
        await sendPrompt(secondSession);
        await server.waitForRequestCount(2);
        assertUserTurns(server.requests[1], [secondSession]);
        const secondState = await waitForConversation(
            (state) => !loadingMessage(state),
            'Session B did not finish.'
        );
        assertVisible(
            !messageByText(secondState, firstSession) && pendingMessages(secondState).length === 0,
            'Session A leaked into Session B.'
        );

        await openHistorySession(firstSession);
        const restored = await waitForConversation(
            (state) => pendingMessages(state).length === 2 && Boolean(loadingMessage(state)),
            'Session A lost its running answer or waiting messages when reopened.'
        );
        assertVisible(!messageByText(restored, secondSession), 'Session B leaked into Session A.');
        finishFirst.resolve();
        await server.waitForRequestCount(3);
        assertUserTurns(server.requests[2], [firstSession, queues[0]]);
        finishQueue.resolve();
        await server.waitForRequestCount(4);
        assertUserTurns(server.requests[3], [firstSession, ...queues]);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'Session A did not drain after returning.'
        );
        await openHistorySession(secondSession);
        const finalSecondState = await readConversationMessages();
        assertVisible(
            pendingMessages(finalSecondState).length === 0 &&
                !messageByText(finalSecondState, queues[0]),
            'Session B acquired Session A messages after delivery.'
        );
        assertVisible(
            server.requests.length === 4,
            'Switching sessions submitted a duplicate prompt.'
        );
    });

    it('user keeps waiting messages after a model connection failure and resumes them before newly queued work', async () => {
        const prompt = 'Queue connection recovery';
        const queues = ['Queue preserved across failure one', 'Queue preserved across failure two'];
        const newTail = 'Queue added after the connection recovers';
        const failConnection = deferred();
        const finishRecoveredHead = deferred();
        const failResponse = async ({ stream }) => {
            stream.text('Partial text before the connection fails.');
            await failConnection.promise;
            server.planNext(failResponse);
            stream.disconnect();
        };
        server.planNext(failResponse);
        await sendPrompt(prompt);
        await server.waitForRequestCount(1);
        await waitForConversation(
            (state) => Boolean(loadingMessage(state)),
            'The interrupted answer did not start.'
        );
        await queuePrompt(queues[0], 1);
        await queuePrompt(queues[1], 2);
        const sessionId = await sessionIdForPrompt(prompt);
        failConnection.resolve();
        await waitForConversation(
            (state) => !loadingMessage(state) && pendingMessages(state).length === 2,
            'The failed answer consumed or kept running the waiting queue.',
            45000
        );
        await waitForDurableQueue(sessionId, queues);
        for (const request of server.requests) {
            assertUserTurns(request, [prompt]);
        }

        server.reset();
        server.planNext(async ({ stream }) => {
            stream.text('Recovered answer for the retained head.');
            await finishRecoveredHead.promise;
            stream.finish();
        });
        for (const text of [queues[1], newTail]) {
            server.planNext(({ stream }) => {
                stream.text(`Recovered answer for ${text}.`);
                stream.finish();
            });
        }
        await sendPrompt(newTail);
        await server.waitForRequestCount(1);
        assertUserTurns(server.requests[0], [prompt, queues[0]]);
        await waitForConversation(
            (state) =>
                messageByText(state, queues[1])?.pendingDelivery === 'queue' &&
                messageByText(state, newTail)?.pendingDelivery === 'queue',
            'Recovery replaced a retained message with the new submission.'
        );
        finishRecoveredHead.resolve();
        await server.waitForRequestCount(3);
        assertUserTurns(server.requests[1], [prompt, ...queues]);
        assertUserTurns(server.requests[2], [prompt, ...queues, newTail]);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The queue did not drain after connection recovery.'
        );
        await waitForDurableQueue(sessionId, []);
        assertVisible(server.requests.length === 3, 'Recovery duplicated queued work.');
    });

    it('user restarts after reordering removing and editing queues then gets each committed message once and none return on another restart', async () => {
        const prompt = 'Queue restart regression';
        const queues = [
            'Restart queue one',
            'Restart queue removed',
            'Restart queue three',
            'Restart queue moved first',
        ];
        const unsaved = 'Unsaved edit must not be delivered';
        const finishOriginal = deferred();
        const finishRecoveredHead = deferred();
        server.planNext(async ({ stream }) => {
            stream.text('Original answer interrupted by an application restart.');
            await finishOriginal.promise;
            stream.finish();
        });
        server.planNext(async ({ stream }) => {
            stream.text('Recovered queue head.');
            await finishRecoveredHead.promise;
            stream.finish();
        });
        for (const text of [queues[0], queues[2]]) {
            server.planNext(({ stream }) => {
                stream.text(`Recovered answer for ${text}.`);
                stream.finish();
            });
        }

        await sendPrompt(prompt);
        await server.waitForRequestCount(1);
        await waitForConversation(
            (state) => Boolean(loadingMessage(state)),
            'The original answer did not start.'
        );
        for (const [index, text] of queues.entries()) {
            await queuePrompt(text, index + 1);
        }
        let state = await readConversationMessages();
        await clickMessageAction(messageByText(state, queues[1]), 'pending-message-remove');
        state = await waitForConversation(
            (messages) => !messageByText(messages, queues[1]),
            'The removed queue stayed visible.'
        );
        await dragQueuedMessage(messageByText(state, queues[3]), messageByText(state, queues[0]));
        state = await waitForConversation(
            (messages) => pendingMessages(messages)[0]?.text === queues[3],
            'Dragging did not reorder the queue before restarting.'
        );
        await clickMessageAction(messageByText(state, queues[0]), 'pending-message-edit');
        await waitForConversation(
            (messages) => messageByText(messages, queues[0])?.editing,
            'The pending message did not enter edit mode.'
        );
        await fillSearchDraft(unsaved);
        const sessionId = await sessionIdForPrompt(prompt);
        await waitForDurableQueue(sessionId, [queues[3], queues[0], queues[2]]);

        await restartApplication();
        finishOriginal.resolve();
        await openHistorySession(prompt);
        await server.waitForRequestCount(2);
        assertUserTurns(server.requests[1], [prompt, queues[3]]);
        const recovered = await waitForConversation(
            (messages) =>
                messageByText(messages, queues[0])?.pendingDelivery === 'queue' &&
                pendingMessages(messages).length === 2 &&
                Boolean(loadingMessage(messages)),
            'Restarting did not restore the remaining queue behind its head.'
        );
        assertVisible(
            !messageByText(recovered, queues[0]).editing && !messageByText(recovered, unsaved),
            'Restarting sent an unsaved edit or left the committed message parked.'
        );
        assertVisible(
            !messageByText(recovered, queues[1]),
            'The removed message returned after restarting.'
        );
        finishRecoveredHead.resolve();
        await server.waitForRequestCount(4);
        assertUserTurns(server.requests[2], [prompt, queues[3], queues[0]]);
        assertUserTurns(server.requests[3], [prompt, queues[3], queues[0], queues[2]]);
        await waitForConversation(
            (messages) => pendingMessages(messages).length === 0 && !loadingMessage(messages),
            'The restored queue did not drain.'
        );
        await waitForDurableQueue(sessionId, []);

        await restartApplication();
        await openHistorySession(prompt);
        const reopened = await waitForConversation(
            (messages) => Boolean(messageByText(messages, queues[2])) && !loadingMessage(messages),
            'The completed session did not reopen as history.'
        );
        assertVisible(
            pendingMessages(reopened).length === 0 && server.requests.length === 4,
            'Delivered or removed messages ran again after the second restart.'
        );
        await waitForDurableQueue(sessionId, []);
    });
});
