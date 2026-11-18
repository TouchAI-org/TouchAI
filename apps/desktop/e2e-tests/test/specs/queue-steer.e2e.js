/**
 * User flows for messages submitted while an answer is still running.
 *
 * These cases use a real local model endpoint because the queue and steer
 * boundaries live in the agent runtime. The server holds a response open while
 * the spec enters messages through the real keyboard, then releases a tool
 * boundary so the spec can check both the visible order and the exact order the
 * model receives.
 */
import { createAgentStreamServer, deferred } from '../support/agent-stream.js';
import {
    backgroundColorOf,
    clickMessageAction,
    dragQueuedMessage,
    editorElement,
    fillSearchDraft,
    hoverPendingAction,
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

const INITIAL_PROMPT = 'Start the running turn';
const DEFAULT_SHORTCUTS = {
    'search.submit.queue': 'Enter',
    'search.submit.priority': 'Mod+Enter',
};
const SWAPPED_SHORTCUTS = {
    'search.submit.queue': 'Mod+Enter',
    'search.submit.priority': 'Enter',
};
const SETTING_TOOL_CALL = {
    name: 'builtin__setting',
    arguments: {
        action: 'get',
        keys: ['language'],
    },
};
const TOOL_CALL_MUTED_COLOR_RGB = [107, 114, 128];

function assertPendingOrder(state, expectedTexts) {
    const actual = pendingMessages(state).map((message) =>
        message.text.replace(/\s+/g, ' ').trim()
    );
    assertVisible(
        JSON.stringify(actual) ===
            JSON.stringify(expectedTexts.map((text) => text.replace(/\s+/g, ' ').trim())),
        `Pending messages were not in the expected order. Expected ${JSON.stringify(
            expectedTexts
        )}, received ${JSON.stringify(actual)}.`
    );
}

function assertToolCallMutedColor(color, label, message) {
    const channels = /^rgb\((\d+), (\d+), (\d+)\)$/
        .exec(color ?? '')
        ?.slice(1)
        .map(Number);
    assertVisible(
        channels?.every(
            (channel, index) => Math.abs(channel - TOOL_CALL_MUTED_COLOR_RGB[index]) <= 2
        ),
        `The queued message ${label} did not match the tool-call color: ${JSON.stringify(message)}.`
    );
}

function assertSolidSteer(message) {
    assertVisible(message !== null, 'The steer message disappeared from the conversation.');
    assertVisible(
        message.pendingDelivery === 'priority',
        `The steer message did not use the priority presentation: ${JSON.stringify(message)}.`
    );
    assertVisible(
        message.backgroundColor !== 'rgba(0, 0, 0, 0)' && message.backgroundColor !== 'transparent',
        `The steer message was not filled: ${JSON.stringify(message)}.`
    );
    assertVisible(
        !message.hasPendingActions && !message.hasSendNow && !message.hasEdit && !message.hasRemove,
        `The steer message still exposed queue controls: ${JSON.stringify(message)}.`
    );
    assertVisible(
        message.actionLabels.length > 0,
        `The steer message lost its normal message actions: ${JSON.stringify(message)}.`
    );
}

function assertQueuedMessage(message) {
    assertVisible(message !== null, 'The queued message disappeared from the conversation.');
    assertVisible(
        message.pendingDelivery === 'queue',
        `The message was not presented as queued: ${JSON.stringify(message)}.`
    );
    assertVisible(
        message.borderStyle === 'dashed',
        `The queued message lost its dashed outline: ${JSON.stringify(message)}.`
    );
    assertToolCallMutedColor(message.textColorRgb, 'text', message);
    assertToolCallMutedColor(message.borderColorRgb, 'outline', message);
    assertVisible(
        message.hasPendingActions && message.hasSendNow && message.hasEdit && message.hasRemove,
        `The queued message lost one of its actions: ${JSON.stringify(message)}.`
    );
    assertVisible(
        message.pendingActionText === '' && message.sendNowLabel === 'Prioritize',
        `The queued message actions were not icon-only with an accessible steer name: ${JSON.stringify(
            message
        )}.`
    );
    assertVisible(
        message.pendingActionIconCount === 3,
        `The queued message actions lost their icons: ${JSON.stringify(message)}.`
    );
}

function assertDeliveredUserMessage(message) {
    assertVisible(message !== null, 'The delivered message disappeared from the conversation.');
    assertVisible(
        message.pendingDelivery === null,
        `The delivered message still looked pending: ${JSON.stringify(message)}.`
    );
    assertVisible(
        message.backgroundColor !== 'rgba(0, 0, 0, 0)' && message.backgroundColor !== 'transparent',
        `The delivered message was not filled like normal history: ${JSON.stringify(message)}.`
    );
    assertVisible(
        !message.hasPendingActions && !message.hasSendNow && !message.hasEdit && !message.hasRemove,
        `The delivered message still exposed pending controls: ${JSON.stringify(message)}.`
    );
    assertVisible(
        message.actionLabels.length > 0,
        `The delivered message lost its normal copy action: ${JSON.stringify(message)}.`
    );
}

function assertReceivedUserTexts(request, expectedTexts) {
    assertVisible(
        JSON.stringify(request.userTexts) === JSON.stringify(expectedTexts),
        `The model did not receive the expected user turns. Expected ${JSON.stringify(
            expectedTexts
        )}, received ${JSON.stringify(request.userTexts)}.`
    );
}

function assertLatestUserText(request, expectedText) {
    const actual = request.userTexts[request.userTexts.length - 1];
    assertVisible(
        actual === expectedText,
        `The model did not receive ${JSON.stringify(expectedText)} last. Received ${JSON.stringify(
            request.userTexts
        )}.`
    );
}

function assertSequentialUserTurns(server, expectedTexts) {
    assertVisible(
        server.requests.length === expectedTexts.length,
        `Expected ${expectedTexts.length} model requests, received ${server.requests.length}.`
    );
    for (const [index, request] of server.requests.entries()) {
        assertReceivedUserTexts(request, expectedTexts.slice(0, index + 1));
    }
    assertVisible(
        server.protocolError === null,
        `The local model server reported a protocol error: ${server.protocolError}`
    );
}

async function startRunningTurn(server) {
    await fillSearchDraft(INITIAL_PROMPT);
    await submitSearchDraft('enter');
    await server.waitForRequestCount(1);
    await waitForConversation(
        (state) => Boolean(loadingMessage(state)),
        'The first assistant turn did not start.'
    );
}

async function discardQueueAndCancelRequest() {
    await callE2eBridge('clearPendingSearchMessages');
    await callE2eBridge('cancelSearchRequest');
}

async function submitWhileRunning(text, chord, delivery, expectedPendingCount) {
    await fillSearchDraft(text);
    await submitSearchDraft(chord);
    const state = await waitForConversation(
        (messages) =>
            pendingMessages(messages).length === expectedPendingCount &&
            Boolean(messageByText(messages, text)),
        `The ${delivery} message ${JSON.stringify(text)} did not appear in the pending area.`
    );
    const message = messageByText(state, text);
    assertVisible(
        message.pendingDelivery === delivery,
        `The message ${JSON.stringify(text)} was delivered as ${
            message.pendingDelivery
        } instead of ${delivery}.`
    );
    return { state, message };
}

async function assertPendingActionHasNoHoverBackground(message, testId) {
    const action = await hoverPendingAction(message, testId);
    const backgroundColor = await backgroundColorOf(action);
    assertVisible(
        backgroundColor === 'rgba(0, 0, 0, 0)' || backgroundColor === 'transparent',
        `The ${testId} action painted a hover background: ${backgroundColor}.`
    );
}

describe('user sends queued and priority messages during a running answer', () => {
    let server;

    before(async () => {
        server = await createAgentStreamServer();
        await waitForE2eBridge();
        await useInterfaceLanguage();
        await resetSearchSurface();
        await callE2eBridge(
            'configureE2eModel',
            server.endpoint,
            server.modelId,
            'TouchAI E2E Model'
        );
    });

    beforeEach(async () => {
        await discardQueueAndCancelRequest();
        await resetSearchSurface();
        await callE2eBridge('setSearchKeybindings', DEFAULT_SHORTCUTS);
        server.reset();
    });

    afterEach(async () => {
        await discardQueueAndCancelRequest();
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'Discarding the queue and cancelling did not clear the loading row before cleanup.'
        );
        await resetSearchSurface();
        server.reset();
    });

    after(async () => {
        await discardQueueAndCancelRequest().catch(() => undefined);
        await resetSearchSurface().catch(() => undefined);
        await server.close();
    });

    it('user sees alternating steers above queues and delivered at the next tool boundary', async () => {
        const releaseToolBoundary = deferred();
        const holdSecondAnswer = deferred();
        const queuedOne = 'Queued message one';
        const steeredOne = 'Steered message one';
        const queuedTwo = 'Queued message two';
        const steeredTwo = 'Steered message two';

        server.planNext(async ({ stream }) => {
            stream.text('Working before the tool boundary.');
            await releaseToolBoundary.promise;
            stream.toolCall(SETTING_TOOL_CALL);
            stream.finish('tool_calls');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Working after the steered messages.');
            await holdSecondAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer for queued message one.');
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer for queued message two.');
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(queuedOne, 'enter', 'queue', 1);
        await submitWhileRunning(steeredOne, 'modified', 'priority', 2);
        await submitWhileRunning(queuedTwo, 'enter', 'queue', 3);
        await submitWhileRunning(steeredTwo, 'modified', 'priority', 4);

        const pendingState = await readConversationMessages();
        assertPendingOrder(pendingState, [steeredOne, steeredTwo, queuedOne, queuedTwo]);
        assertSolidSteer(messageByText(pendingState, steeredOne));
        assertSolidSteer(messageByText(pendingState, steeredTwo));
        assertQueuedMessage(messageByText(pendingState, queuedOne));
        assertQueuedMessage(messageByText(pendingState, queuedTwo));
        for (const testId of [
            'pending-message-send-now',
            'pending-message-edit',
            'pending-message-remove',
        ]) {
            await assertPendingActionHasNoHoverBackground(
                messageByText(pendingState, queuedOne),
                testId
            );
        }
        await (await editorElement()).moveTo();

        const firstLoading = loadingMessage(pendingState);
        const firstSteer = messageByText(pendingState, steeredOne);
        const firstQueued = messageByText(pendingState, queuedOne);
        assertVisible(
            firstLoading.index < firstSteer.index && firstSteer.index < firstQueued.index,
            `Undelivered steers were not between loading and queued messages: ${JSON.stringify(
                pendingState
            )}.`
        );
        assertVisible(
            pendingState[pendingState.length - 2].text === queuedOne &&
                pendingState[pendingState.length - 1].text === queuedTwo,
            `Queued messages were not pinned below every other row: ${JSON.stringify(
                pendingState
            )}.`
        );

        releaseToolBoundary.resolve();
        await server.waitForRequestCount(2);
        assertReceivedUserTexts(server.requests[1], [INITIAL_PROMPT, steeredOne, steeredTwo]);

        const afterBoundary = await waitForConversation((state) => {
            const steered = messageByText(state, steeredOne);
            const loading = loadingMessage(state);
            return (
                steered?.pendingDelivery === null &&
                loadedBeforeQueued(state) &&
                Boolean(loading) &&
                steered.index < loading.index
            );
        }, 'The delivered steers did not move into history above the new loading row.');
        assertDeliveredUserMessage(messageByText(afterBoundary, steeredOne));
        assertDeliveredUserMessage(messageByText(afterBoundary, steeredTwo));
        assertQueuedMessage(messageByText(afterBoundary, queuedOne));
        assertQueuedMessage(messageByText(afterBoundary, queuedTwo));
        assertVisible(
            messageByText(afterBoundary, queuedOne).textColorRgb !==
                messageByText(afterBoundary, steeredOne).textColorRgb,
            `The queued message lost its muted color after delivery: ${JSON.stringify(
                afterBoundary
            )}.`
        );

        const secondLoading = loadingMessage(afterBoundary);
        const secondQueued = messageByText(afterBoundary, queuedOne);
        assertVisible(
            secondLoading.index < secondQueued.index,
            `The loading row did not move above the remaining queue: ${JSON.stringify(
                afterBoundary
            )}.`
        );

        holdSecondAnswer.resolve();
        await server.waitForRequestCount(3);
        assertLatestUserText(server.requests[2], queuedOne);
        await server.waitForRequestCount(4);
        assertLatestUserText(server.requests[3], queuedTwo);

        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The conversation did not drain after both queued messages ran.'
        );
        assertVisible(
            server.protocolError === null,
            `The local model server reported a protocol error: ${server.protocolError}`
        );
    });

    it('user gets queued messages reordered by dragging before the next turn starts', async () => {
        const releaseAnswer = deferred();
        const queuedFirst = 'Queue that starts after the drag';
        const queuedSecond = 'Queue dragged above it';

        server.planNext(async ({ stream }) => {
            stream.text('Holding the answer while the queue is reordered.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer for the queue dragged to the top.');
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer for the queue left at the bottom.');
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(queuedFirst, 'enter', 'queue', 1);
        await submitWhileRunning(queuedSecond, 'enter', 'queue', 2);

        const beforeDrag = await readConversationMessages();
        assertPendingOrder(beforeDrag, [queuedFirst, queuedSecond]);
        await dragQueuedMessage(
            messageByText(beforeDrag, queuedSecond),
            messageByText(beforeDrag, queuedFirst),
            async () => {
                const dragPreview = await browser.execute(() => {
                    const isRendered = (element) => {
                        const style = getComputedStyle(element);
                        return (
                            style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            Number.parseFloat(style.opacity) > 0
                        );
                    };
                    const fallback = Array.from(
                        document.querySelectorAll('.sortable-fallback')
                    ).find(isRendered);
                    const placeholders = Array.from(
                        document.querySelectorAll(
                            '[data-testid="pending-queue-list"] [data-queue-message].invisible'
                        )
                    );
                    return {
                        fallbackText: fallback?.textContent ?? '',
                        fallbackVisible: Boolean(fallback),
                        placeholderCount: placeholders.length,
                        placeholdersHidden: placeholders.every((element) => !isRendered(element)),
                    };
                });

                assertVisible(
                    dragPreview.fallbackVisible && dragPreview.fallbackText.includes(queuedSecond),
                    `The pointer-following drag ghost was missing or showed the wrong queue: ${JSON.stringify(
                        dragPreview
                    )}.`
                );
                assertVisible(
                    dragPreview.placeholderCount === 1 && dragPreview.placeholdersHidden,
                    `The drop-position drag ghost was still visible: ${JSON.stringify(
                        dragPreview
                    )}.`
                );
            }
        );

        const afterDrag = await waitForConversation((state) => {
            const queues = pendingMessages(state).filter(
                (message) => message.pendingDelivery === 'queue'
            );
            return (
                queues.length === 2 &&
                queues[0]?.text === queuedSecond &&
                queues[1]?.text === queuedFirst
            );
        }, 'Dragging the second queued bubble did not move it above the first.');
        assertPendingOrder(afterDrag, [queuedSecond, queuedFirst]);
        assertQueuedMessage(messageByText(afterDrag, queuedSecond));
        assertQueuedMessage(messageByText(afterDrag, queuedFirst));
        const selectionAfterDrag = await browser.execute(
            () => window.getSelection()?.toString() ?? ''
        );
        assertVisible(
            selectionAfterDrag === '',
            `Dragging a queued message selected its text: ${JSON.stringify(selectionAfterDrag)}.`
        );

        releaseAnswer.resolve();
        await server.waitForRequestCount(2);
        assertLatestUserText(server.requests[1], queuedSecond);
        await server.waitForRequestCount(3);
        assertLatestUserText(server.requests[2], queuedFirst);

        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The reordered queue did not drain in its new order.'
        );
        assertVisible(
            server.protocolError === null,
            `The local model server reported a protocol error: ${server.protocolError}`
        );
    });

    it('user keeps steers grouped above queues when steering before queueing', async () => {
        const releaseAnswer = deferred();
        const steeredOne = 'First steer';
        const queuedOne = 'First queue';
        const steeredTwo = 'Second steer';
        const queuedTwo = 'Second queue';

        server.planNext(async ({ stream }) => {
            stream.text('Holding the first answer open.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(steeredOne, 'modified', 'priority', 1);
        await submitWhileRunning(queuedOne, 'enter', 'queue', 2);
        await submitWhileRunning(steeredTwo, 'modified', 'priority', 3);
        await submitWhileRunning(queuedTwo, 'enter', 'queue', 4);

        const state = await readConversationMessages();
        assertPendingOrder(state, [steeredOne, steeredTwo, queuedOne, queuedTwo]);
        assertSolidSteer(messageByText(state, steeredOne));
        assertSolidSteer(messageByText(state, steeredTwo));
        assertQueuedMessage(messageByText(state, queuedOne));
        assertQueuedMessage(messageByText(state, queuedTwo));
        assertVisible(
            state[state.length - 2].text === queuedOne &&
                state[state.length - 1].text === queuedTwo,
            `Queues submitted between steers were not pinned to the bottom: ${JSON.stringify(
                state
            )}.`
        );

        await discardQueueAndCancelRequest();
        releaseAnswer.resolve();
    });

    it('user gets a steer downgraded into the next turn when no tool boundary arrives', async () => {
        const releaseAnswer = deferred();
        const holdNextTurn = deferred();
        const steered = 'Steer without a tool boundary';

        server.planNext(async ({ stream }) => {
            stream.text('Answer that ends without a tool call.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Answering the downgraded message.');
            await holdNextTurn.promise;
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(steered, 'modified', 'priority', 1);
        releaseAnswer.resolve();

        await server.waitForRequestCount(2);
        assertLatestUserText(server.requests[1], steered);
        assertVisible(
            server.requests[1].userTexts.filter((text) => text === steered).length === 1,
            `The downgraded steer was duplicated or lost: ${JSON.stringify(
                server.requests[1].userTexts
            )}.`
        );

        const nextTurnState = await waitForConversation(
            (state) =>
                messageByText(state, steered)?.pendingDelivery === null &&
                Boolean(loadingMessage(state)),
            'The downgraded steer did not become a normal user turn.'
        );
        assertVisible(
            nextTurnState.filter((message) => message.text === steered).length === 1,
            `The downgraded steer appeared more than once in the conversation: ${JSON.stringify(
                nextTurnState
            )}.`
        );

        holdNextTurn.resolve();
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The downgraded message did not finish its next turn.'
        );
    });

    it('user sends a burst of mixed messages once with steers before earlier queues and empty Enter ignored', async () => {
        const releaseAnswer = deferred();
        const queues = Array.from({ length: 6 }, (_, index) => `Burst queue ${index + 1}`);
        const steers = ['Burst priority one', 'Burst priority two'];

        server.planNext(async ({ stream }) => {
            stream.text('Holding a text-only answer during rapid submissions.');
            await releaseAnswer.promise;
            stream.finish();
        });
        for (const text of [...steers, ...queues]) {
            server.planNext(({ stream }) => {
                stream.text(`Answer for ${text}.`);
                stream.finish();
            });
        }

        await startRunningTurn(server);
        let pendingCount = 0;
        for (const [index, text] of queues.entries()) {
            await submitWhileRunning(text, 'enter', 'queue', ++pendingCount);
            if (index === 2 || index === 5) {
                await submitWhileRunning(
                    steers[index === 2 ? 0 : 1],
                    'modified',
                    'priority',
                    ++pendingCount
                );
            }
        }
        for (let index = 0; index < 3; index += 1) {
            await submitSearchDraft('enter');
        }
        assertPendingOrder(await readConversationMessages(), [...steers, ...queues]);
        assertVisible(
            server.requests.length === 1,
            'Pending or empty input started a second turn.'
        );

        releaseAnswer.resolve();
        await server.waitForRequestCount(9);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The rapid submissions did not drain.'
        );
        assertSequentialUserTurns(server, [INITIAL_PROMPT, ...steers, ...queues]);
    });

    it('user removes the head and a middle queue then sends only the retained messages and a new tail', async () => {
        const releaseAnswer = deferred();
        const queues = Array.from({ length: 4 }, (_, index) => `Removable queue ${index + 1}`);
        const newTail = 'Queue appended after removals';
        const retained = [queues[1], queues[3], newTail];

        server.planNext(async ({ stream }) => {
            stream.text('Holding the answer while unwanted messages are removed.');
            await releaseAnswer.promise;
            stream.finish();
        });
        for (const text of retained) {
            server.planNext(({ stream }) => {
                stream.text(`Answer for ${text}.`);
                stream.finish();
            });
        }

        await startRunningTurn(server);
        for (const [index, text] of queues.entries()) {
            await submitWhileRunning(text, 'enter', 'queue', index + 1);
        }
        for (const text of [queues[0], queues[2]]) {
            await clickMessageAction(
                messageByText(await readConversationMessages(), text),
                'pending-message-remove'
            );
            await waitForConversation(
                (state) => !messageByText(state, text),
                `Removing ${text} did not remove its pending bubble.`
            );
        }
        await submitWhileRunning(newTail, 'enter', 'queue', 3);
        assertPendingOrder(await readConversationMessages(), retained);

        releaseAnswer.resolve();
        await server.waitForRequestCount(4);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'Removing messages prevented the retained queue from draining.'
        );
        assertSequentialUserTurns(server, [INITIAL_PROMPT, ...retained]);
    });

    it('user saves Chinese multiline text in a middle queue without submitting its newline or changing its slot', async () => {
        const releaseAnswer = deferred();
        const firstQueue = 'Queue before the multiline edit';
        const original = 'Middle queue opened for a multiline edit';
        const lastQueue = 'Queue after the multiline edit';
        const firstLine = '中文第一行';
        const secondLine = '第二行，请保留换行。';
        const edited = `${firstLine}\n${secondLine}`;

        server.planNext(async ({ stream }) => {
            stream.text('Holding the answer while a multiline edit is composed.');
            await releaseAnswer.promise;
            stream.finish();
        });
        for (const text of [firstQueue, edited, lastQueue]) {
            server.planNext(({ stream }) => {
                stream.text(`Answer for ${text}.`);
                stream.finish();
            });
        }

        await startRunningTurn(server);
        await submitWhileRunning(firstQueue, 'enter', 'queue', 1);
        const { message } = await submitWhileRunning(original, 'enter', 'queue', 2);
        await submitWhileRunning(lastQueue, 'enter', 'queue', 3);
        await clickMessageAction(message, 'pending-message-edit');
        await waitForConversation(
            (state) => messageByText(state, original)?.editing,
            'The middle queue did not enter editing state.'
        );
        await pressEditorKey('a', { modified: true });
        await browser.keys([firstLine]);
        await browser.keys(['Shift', 'Enter']);
        await browser.releaseActions();
        await browser.keys([secondLine]);
        const draft = await (await editorElement()).getText();
        assertVisible(
            draft === edited,
            `The multiline edit lost its text: ${JSON.stringify(draft)}.`
        );
        assertVisible(server.requests.length === 1, 'Shift+Enter sent the unfinished edit.');
        assertPendingOrder(await readConversationMessages(), [firstQueue, original, lastQueue]);

        await submitSearchDraft('enter');
        const saved = await waitForConversation(
            (state) =>
                messageByText(state, edited)?.id === message.id &&
                !messageByText(state, edited)?.editing,
            'Saving the multiline edit did not replace the same pending message.'
        );
        assertPendingOrder(saved, [firstQueue, edited, lastQueue]);
        releaseAnswer.resolve();
        await server.waitForRequestCount(4);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The queue containing a multiline edit did not drain.'
        );
        assertSequentialUserTurns(server, [INITIAL_PROMPT, firstQueue, edited, lastQueue]);
    });

    it('user keeps a queue behind a steer downgraded at the end of a run', async () => {
        const releaseAnswer = deferred();
        const holdSteerAnswer = deferred();
        const steered = 'Steer that misses every tool boundary';
        const queued = 'Queue waiting behind the downgraded steer';

        server.planNext(async ({ stream }) => {
            stream.text('Answer with no tool call.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Answer for the downgraded steer.');
            await holdSteerAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer for the queue behind it.');
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(steered, 'modified', 'priority', 1);
        await submitWhileRunning(queued, 'enter', 'queue', 2);

        const beforeCompletion = await readConversationMessages();
        assertPendingOrder(beforeCompletion, [steered, queued]);
        assertSolidSteer(messageByText(beforeCompletion, steered));
        assertQueuedMessage(messageByText(beforeCompletion, queued));

        releaseAnswer.resolve();
        await server.waitForRequestCount(2);
        assertReceivedUserTexts(server.requests[1], [INITIAL_PROMPT, steered]);

        const downgraded = await waitForConversation(
            (state) =>
                messageByText(state, steered)?.pendingDelivery === null &&
                messageByText(state, queued)?.pendingDelivery === 'queue' &&
                Boolean(loadingMessage(state)),
            'The downgraded steer did not start ahead of the waiting queue.'
        );
        assertDeliveredUserMessage(messageByText(downgraded, steered));
        assertQueuedMessage(messageByText(downgraded, queued));
        const downgradedLoading = loadingMessage(downgraded);
        assertVisible(
            messageByText(downgraded, steered).index < downgradedLoading.index &&
                downgradedLoading.index < messageByText(downgraded, queued).index,
            `The downgraded steer, loading row, and queue were out of order: ${JSON.stringify(
                downgraded
            )}.`
        );

        holdSteerAnswer.resolve();
        await server.waitForRequestCount(3);
        assertLatestUserText(server.requests[2], queued);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The queue behind the downgraded steer did not run after the steer turn completed.'
        );
    });

    it('user gets a steer that misses the end of the run ahead of earlier queues', async () => {
        const releaseAnswer = deferred();
        const holdSteerAnswer = deferred();
        const holdFirstQueueAnswer = deferred();
        const queuedFirst = 'Queue submitted before the steer';
        const queuedSecond = 'Second queue submitted before the steer';
        const steered = 'Steer submitted after both queues';

        server.planNext(async ({ stream }) => {
            stream.text('Answer with no tool call.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Answer for the downgraded steer.');
            await holdSteerAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Answer for the first queue.');
            await holdFirstQueueAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer for the second queue.');
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(queuedFirst, 'enter', 'queue', 1);
        await submitWhileRunning(queuedSecond, 'enter', 'queue', 2);
        await submitWhileRunning(steered, 'modified', 'priority', 3);

        const beforeCompletion = await readConversationMessages();
        assertPendingOrder(beforeCompletion, [steered, queuedFirst, queuedSecond]);
        assertSolidSteer(messageByText(beforeCompletion, steered));
        assertQueuedMessage(messageByText(beforeCompletion, queuedFirst));
        assertQueuedMessage(messageByText(beforeCompletion, queuedSecond));

        releaseAnswer.resolve();
        await server.waitForRequestCount(2);
        assertReceivedUserTexts(server.requests[1], [INITIAL_PROMPT, steered]);

        const downgraded = await waitForConversation(
            (state) =>
                messageByText(state, steered)?.pendingDelivery === null &&
                messageByText(state, queuedFirst)?.pendingDelivery === 'queue' &&
                Boolean(loadingMessage(state)),
            'The downgraded steer did not start ahead of the queues submitted before it.'
        );
        assertDeliveredUserMessage(messageByText(downgraded, steered));
        assertQueuedMessage(messageByText(downgraded, queuedFirst));
        assertQueuedMessage(messageByText(downgraded, queuedSecond));

        holdSteerAnswer.resolve();
        await server.waitForRequestCount(3);
        assertLatestUserText(server.requests[2], queuedFirst);
        await waitForConversation(
            (state) =>
                messageByText(state, queuedFirst)?.pendingDelivery === null &&
                messageByText(state, queuedSecond)?.pendingDelivery === 'queue' &&
                Boolean(loadingMessage(state)),
            'The first queue did not run after the downgraded steer turn.'
        );

        holdFirstQueueAnswer.resolve();
        await server.waitForRequestCount(4);
        assertLatestUserText(server.requests[3], queuedSecond);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The second queue did not run after the first queue turn.'
        );
    });

    it('user steers again after one tool boundary while earlier queues stay pending', async () => {
        const releaseFirstBoundary = deferred();
        const releaseSecondBoundary = deferred();
        const holdFinalAnswer = deferred();
        const firstSteer = 'Steer at the first tool boundary';
        const secondSteer = 'Steer added after the first boundary';
        const queued = 'Queue that waits for every steer';

        server.planNext(async ({ stream }) => {
            stream.text('Working until the first tool boundary.');
            await releaseFirstBoundary.promise;
            stream.toolCall({ ...SETTING_TOOL_CALL, id: 'call_touchai_e2e_first' });
            stream.finish('tool_calls');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Working until the second tool boundary.');
            await releaseSecondBoundary.promise;
            stream.toolCall({ ...SETTING_TOOL_CALL, id: 'call_touchai_e2e_second' });
            stream.finish('tool_calls');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Answering after both steers were inserted.');
            await holdFinalAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer for the queue after both steers.');
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(queued, 'enter', 'queue', 1);
        await submitWhileRunning(firstSteer, 'modified', 'priority', 2);

        releaseFirstBoundary.resolve();
        await server.waitForRequestCount(2);
        assertReceivedUserTexts(server.requests[1], [INITIAL_PROMPT, firstSteer]);

        const afterFirstBoundary = await waitForConversation(
            (state) =>
                messageByText(state, firstSteer)?.pendingDelivery === null &&
                messageByText(state, queued)?.pendingDelivery === 'queue' &&
                Boolean(loadingMessage(state)),
            'The first steer was not delivered at the first tool boundary.'
        );
        assertDeliveredUserMessage(messageByText(afterFirstBoundary, firstSteer));
        assertQueuedMessage(messageByText(afterFirstBoundary, queued));

        await submitWhileRunning(secondSteer, 'modified', 'priority', 2);
        const beforeSecondBoundary = await readConversationMessages();
        const secondSteerMessage = messageByText(beforeSecondBoundary, secondSteer);
        const secondLoading = loadingMessage(beforeSecondBoundary);
        assertSolidSteer(secondSteerMessage);
        assertVisible(
            secondLoading.index < secondSteerMessage.index &&
                secondSteerMessage.index < messageByText(beforeSecondBoundary, queued).index,
            `The second steer was not waiting between loading and the queue: ${JSON.stringify(
                beforeSecondBoundary
            )}.`
        );

        releaseSecondBoundary.resolve();
        await server.waitForRequestCount(3);
        assertReceivedUserTexts(server.requests[2], [INITIAL_PROMPT, firstSteer, secondSteer]);

        const afterSecondBoundary = await waitForConversation(
            (state) =>
                messageByText(state, secondSteer)?.pendingDelivery === null &&
                messageByText(state, queued)?.pendingDelivery === 'queue' &&
                Boolean(loadingMessage(state)),
            'The second steer was not delivered at the second tool boundary.'
        );
        assertDeliveredUserMessage(messageByText(afterSecondBoundary, secondSteer));
        assertQueuedMessage(messageByText(afterSecondBoundary, queued));
        const finalLoading = loadingMessage(afterSecondBoundary);
        assertVisible(
            messageByText(afterSecondBoundary, secondSteer).index < finalLoading.index &&
                finalLoading.index < messageByText(afterSecondBoundary, queued).index,
            `The delivered steer, loading row, and queue were out of order: ${JSON.stringify(
                afterSecondBoundary
            )}.`
        );

        holdFinalAnswer.resolve();
        await server.waitForRequestCount(4);
        assertLatestUserText(server.requests[3], queued);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The queue did not run after the turn with two steer boundaries finished.'
        );
    });

    it('user immediately steers a queued message while another queue stays at the bottom', async () => {
        const releasePromotedSteer = deferred();
        const finishPromotedStream = deferred();
        const holdPromotedAnswer = deferred();
        const queuedOne = 'Queue that becomes an immediate steer';
        const queuedTwo = 'Queue that waits for the next turn';

        server.planNext(async ({ stream }) => {
            stream.text('Working before the user promotes a queue.');
            await releasePromotedSteer.promise;
            stream.text('Continuing until the immediate steer boundary.');
            // Keep the first response open. A second request must arrive before
            // it ends, proving the steer cut this stream instead of falling
            // back to an end-of-run queue.
            await finishPromotedStream.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Answering the promoted message.');
            await holdPromotedAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answering the remaining queued message.');
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(queuedOne, 'enter', 'queue', 1);
        await submitWhileRunning(queuedTwo, 'enter', 'queue', 2);

        const beforePromotion = await readConversationMessages();
        await clickMessageAction(
            messageByText(beforePromotion, queuedOne),
            'pending-message-send-now'
        );

        const promoted = await waitForConversation((state) => {
            const message = messageByText(state, queuedOne);
            return (
                message?.pendingDelivery === 'priority' &&
                message.backgroundColor !== 'rgba(0, 0, 0, 0)'
            );
        }, 'Clicking Prioritize did not turn the queued bubble into a solid steer.');
        assertSolidSteer(messageByText(promoted, queuedOne));
        assertQueuedMessage(messageByText(promoted, queuedTwo));
        const loadingBeforeDelivery = loadingMessage(promoted);
        assertVisible(
            loadingBeforeDelivery.index < messageByText(promoted, queuedOne).index,
            `The promoted but undelivered steer moved above loading: ${JSON.stringify(promoted)}.`
        );

        releasePromotedSteer.resolve();
        await server.waitForRequestCount(2);
        finishPromotedStream.resolve();
        assertLatestUserText(server.requests[1], queuedOne);

        const afterDelivery = await waitForConversation((state) => {
            const promotedMessage = messageByText(state, queuedOne);
            const queuedMessage = messageByText(state, queuedTwo);
            const loading = loadingMessage(state);
            return (
                promotedMessage?.pendingDelivery === null &&
                queuedMessage?.pendingDelivery === 'queue' &&
                Boolean(loading) &&
                promotedMessage.index < loading.index &&
                loading.index < queuedMessage.index
            );
        }, 'The delivered immediate steer did not sit above loading with the queue still at the bottom.');
        assertDeliveredUserMessage(messageByText(afterDelivery, queuedOne));
        assertQueuedMessage(messageByText(afterDelivery, queuedTwo));

        holdPromotedAnswer.resolve();
        await server.waitForRequestCount(3);
        assertLatestUserText(server.requests[2], queuedTwo);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The queue left behind by the immediate steer did not run next.'
        );
    });

    it('user edits a queue in place without changing its slot or a pending steer', async () => {
        const releaseAnswer = deferred();
        const queuedToEdit = 'Queue opened for editing';
        const editedQueue = 'Queue saved after editing';
        const steered = 'Steer that must remain committed';
        const queuedToRemove = 'Queue removed by the user';

        server.planNext(async ({ stream }) => {
            stream.text('Keeping the turn open for queue actions.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(queuedToEdit, 'enter', 'queue', 1);
        await submitWhileRunning(steered, 'modified', 'priority', 2);
        await submitWhileRunning(queuedToRemove, 'enter', 'queue', 3);

        let state = await readConversationMessages();
        await clickMessageAction(messageByText(state, queuedToRemove), 'pending-message-remove');
        state = await waitForConversation(
            (messages) =>
                !messageByText(messages, queuedToRemove) && pendingMessages(messages).length === 2,
            'Cancelling one queued message removed or changed another pending row.'
        );
        assertPendingOrder(state, [steered, queuedToEdit]);
        assertSolidSteer(messageByText(state, steered));

        await clickMessageAction(messageByText(state, queuedToEdit), 'pending-message-edit');
        state = await waitForConversation(
            (messages) =>
                messageByText(messages, queuedToEdit)?.editing === true &&
                pendingMessages(messages).length === 2,
            'Opening a queued message for editing did not keep it in the pending area.'
        );
        assertPendingOrder(state, [steered, queuedToEdit]);
        const editingMessage = messageByText(state, queuedToEdit);
        assertVisible(
            editingMessage.editingStatus === 'Editing' &&
                editingMessage.hasCancelEdit &&
                !editingMessage.hasSendNow &&
                !editingMessage.hasEdit &&
                !editingMessage.hasRemove,
            `The queue did not show the editing state in place: ${JSON.stringify(editingMessage)}.`
        );
        assertVisible(
            editingMessage.borderStyle === 'dashed' &&
                (editingMessage.backgroundColor === 'rgba(0, 0, 0, 0)' ||
                    editingMessage.backgroundColor === 'transparent'),
            `Editing changed the queued bubble surface: ${JSON.stringify(editingMessage)}.`
        );
        assertToolCallMutedColor(
            editingMessage.pendingActionColorRgb,
            'editing actions',
            editingMessage
        );
        assertSolidSteer(messageByText(state, steered));
        const restoredDraft = await (await editorElement()).getText();
        assertVisible(
            restoredDraft.includes(queuedToEdit),
            `Editing did not restore the queued prompt into the editor: ${JSON.stringify(
                restoredDraft
            )}.`
        );

        await fillSearchDraft(editedQueue);
        await submitSearchDraft('enter');
        state = await waitForConversation(
            (messages) =>
                !messageByText(messages, queuedToEdit) &&
                messageByText(messages, editedQueue)?.id === editingMessage.id &&
                messageByText(messages, editedQueue)?.editing === false &&
                pendingMessages(messages).length === 2,
            'Saving an edited queue did not replace it in place.'
        );
        assertPendingOrder(state, [steered, editedQueue]);
        assertQueuedMessage(messageByText(state, editedQueue));
        assertSolidSteer(messageByText(state, steered));

        await discardQueueAndCancelRequest();
        releaseAnswer.resolve();
    });

    it('user gets the next queue started while an earlier queue is being edited', async () => {
        const releaseFirstAnswer = deferred();
        const releaseSecondAnswer = deferred();
        const heldForEdit = 'Queue held out of delivery while editing';
        const nextQueued = 'Queue that runs while the edit is open';
        const editedQueue = 'Queue saved after the next turn started';

        server.planNext(async ({ stream }) => {
            stream.text('Holding the first answer while a queue is edited.');
            await releaseFirstAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Running the queue that was not being edited.');
            await releaseSecondAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answering the edited queue last.');
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(heldForEdit, 'enter', 'queue', 1);
        await submitWhileRunning(nextQueued, 'enter', 'queue', 2);

        const state = await readConversationMessages();
        await clickMessageAction(messageByText(state, heldForEdit), 'pending-message-edit');
        const editingState = await waitForConversation(
            (messages) =>
                messageByText(messages, heldForEdit)?.editing === true &&
                pendingMessages(messages).length === 2,
            'Opening the first queue for editing did not keep it parked in the pending area.'
        );
        const editingMessage = messageByText(editingState, heldForEdit);

        releaseFirstAnswer.resolve();
        await server.waitForRequestCount(2);
        assertLatestUserText(server.requests[1], nextQueued);

        await waitForConversation(
            (messages) =>
                messageByText(messages, heldForEdit)?.editing === true &&
                messageByText(messages, nextQueued)?.pendingDelivery === null &&
                Boolean(loadingMessage(messages)),
            'The edited queue was delivered before the queue behind it.'
        );

        await fillSearchDraft(editedQueue);
        await submitSearchDraft('enter');
        await waitForConversation(
            (messages) =>
                messageByText(messages, editedQueue)?.id === editingMessage.id &&
                messageByText(messages, editedQueue)?.editing === false &&
                messageByText(messages, nextQueued)?.pendingDelivery === null,
            'Saving the edit did not leave the edited queue waiting behind the running turn.'
        );

        releaseSecondAnswer.resolve();
        await server.waitForRequestCount(3);
        assertLatestUserText(server.requests[2], editedQueue);
        await waitForConversation(
            (messages) => pendingMessages(messages).length === 0 && !loadingMessage(messages),
            'The edited queue did not run after the queue ahead of it finished.'
        );
    });

    it('user can keep queueing after cancelling an edit once the original queue drains', async () => {
        const releaseFirstAnswer = deferred();
        const releaseHeldAnswer = deferred();
        const releaseNewQueueAnswer = deferred();
        const heldForEdit = 'Queue held after the original answer finishes';
        const newQueue = 'Queue added while the held queue is running';

        server.planNext(async ({ stream }) => {
            stream.text('Finishing the answer while one queue remains in edit.');
            await releaseFirstAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Running the queue whose edit was cancelled.');
            await releaseHeldAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Running the queue added after the edit ended.');
            await releaseNewQueueAnswer.promise;
            stream.finish('stop');
        });

        await startRunningTurn(server);
        const { message: heldMessage } = await submitWhileRunning(heldForEdit, 'enter', 'queue', 1);
        await clickMessageAction(heldMessage, 'pending-message-edit');
        await waitForConversation(
            (messages) =>
                messageByText(messages, heldForEdit)?.editing === true &&
                pendingMessages(messages).length === 1,
            'Opening the only queue for editing did not keep it parked.'
        );

        releaseFirstAnswer.resolve();
        const afterOriginalTurn = await waitForConversation(
            (messages) =>
                messageByText(messages, heldForEdit)?.editing === true && !loadingMessage(messages),
            'The edited queue did not remain parked after the original answer finished.'
        );

        await clickMessageAction(
            messageByText(afterOriginalTurn, heldForEdit),
            'pending-message-cancel-edit'
        );
        await server.waitForRequestCount(2);
        assertLatestUserText(server.requests[1], heldForEdit);
        await waitForConversation(
            (messages) =>
                messageByText(messages, heldForEdit)?.pendingDelivery === null &&
                Boolean(loadingMessage(messages)),
            'Cancelling the edit did not start the held queue.'
        );

        await submitWhileRunning(newQueue, 'enter', 'queue', 1);
        releaseHeldAnswer.resolve();
        await server.waitForRequestCount(3);
        assertLatestUserText(server.requests[2], newQueue);
        await waitForConversation(
            (messages) =>
                messageByText(messages, newQueue)?.pendingDelivery === null &&
                Boolean(loadingMessage(messages)),
            'The new queue message did not start after the held queue finished.'
        );

        releaseNewQueueAnswer.resolve();
        await waitForConversation(
            (messages) => pendingMessages(messages).length === 0 && !loadingMessage(messages),
            'The queue stayed stuck after the original queue drained and a new queue ran.'
        );
    });

    it('user saves an edit after all runnable messages finish and can queue another message behind it', async () => {
        const releaseFirstAnswer = deferred();
        const releaseEditedAnswer = deferred();
        const parked = 'Queue parked while the rest finish';
        const runnable = 'Queue that finishes while editing';
        const edited = 'Edited queue saved after every other turn finished';
        const newQueue = 'New queue after saving an idle edit';

        server.planNext(async ({ stream }) => {
            stream.text('Finishing the original answer with one message parked.');
            await releaseFirstAnswer.promise;
            stream.finish();
        });
        server.planNext(({ stream }) => {
            stream.text('Finishing the last runnable message.');
            stream.finish();
        });
        server.planNext(async ({ stream }) => {
            stream.text('Answering the saved edit.');
            await releaseEditedAnswer.promise;
            stream.finish();
        });
        server.planNext(({ stream }) => {
            stream.text('Answering the newly queued message.');
            stream.finish();
        });

        await startRunningTurn(server);
        const { message } = await submitWhileRunning(parked, 'enter', 'queue', 1);
        await submitWhileRunning(runnable, 'enter', 'queue', 2);
        await clickMessageAction(message, 'pending-message-edit');
        await waitForConversation(
            (state) => messageByText(state, parked)?.editing,
            'The first queue did not remain parked for editing.'
        );
        releaseFirstAnswer.resolve();
        await server.waitForRequestCount(2);
        await waitForConversation(
            (state) => messageByText(state, parked)?.editing && !loadingMessage(state),
            'The parked message ran before its edit finished.'
        );

        await fillSearchDraft(edited);
        await submitSearchDraft('enter');
        await server.waitForRequestCount(3);
        await waitForConversation(
            (state) =>
                messageByText(state, edited)?.pendingDelivery === null &&
                Boolean(loadingMessage(state)),
            'Saving the idle edit did not start its answer.'
        );
        await submitWhileRunning(newQueue, 'enter', 'queue', 1);
        releaseEditedAnswer.resolve();
        await server.waitForRequestCount(4);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The queue stayed stuck after saving the edit.'
        );
        assertSequentialUserTurns(server, [INITIAL_PROMPT, runnable, edited, newQueue]);
    });

    it('user can cancel editing without removing the queued message', async () => {
        const releaseAnswer = deferred();
        const queuedToEdit = 'Queue whose edit will be cancelled';
        const draftToKeep = 'Draft that was already in the composer';

        server.planNext(async ({ stream }) => {
            stream.text('Keeping the turn open while an edit is cancelled.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });

        await startRunningTurn(server);
        const { message } = await submitWhileRunning(queuedToEdit, 'enter', 'queue', 1);
        await fillSearchDraft(draftToKeep);
        await clickMessageAction(message, 'pending-message-edit');

        const editingState = await waitForConversation(
            (state) => messageByText(state, queuedToEdit)?.editing === true,
            'Opening the queue for editing did not expose the editing state.'
        );
        await clickMessageAction(
            messageByText(editingState, queuedToEdit),
            'pending-message-cancel-edit'
        );

        const cancelledState = await waitForConversation(
            (state) =>
                messageByText(state, queuedToEdit)?.editing === false &&
                pendingMessages(state).length === 1,
            'Cancelling the edit removed the queued message or left it in editing state.'
        );
        assertQueuedMessage(messageByText(cancelledState, queuedToEdit));
        assertVisible(
            (await (await editorElement()).getText()).trim() === draftToKeep,
            'Cancelling the edit did not restore the draft that was in the composer before editing.'
        );

        await discardQueueAndCancelRequest();
        releaseAnswer.resolve();
    });

    it('user gets an external reply queued without overwriting the message being edited', async () => {
        const releaseAnswer = deferred();
        const queuedToEdit = 'Queue that stays in edit while a widget replies';
        const externalReply = 'Reply that came from outside the composer';

        server.planNext(async ({ stream }) => {
            stream.text('Keeping the turn open while an external reply arrives.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });

        await startRunningTurn(server);
        const { message } = await submitWhileRunning(queuedToEdit, 'enter', 'queue', 1);
        await clickMessageAction(message, 'pending-message-edit');
        await waitForConversation(
            (state) => messageByText(state, queuedToEdit)?.editing === true,
            'Opening the queue for editing did not expose the editing state.'
        );
        const draftBeforeExternalReply = (await (await editorElement()).getText()).trim();

        await callE2eBridge('sendPrompt', externalReply);
        const state = await waitForConversation(
            (messages) =>
                pendingMessages(messages).length === 2 &&
                messageByText(messages, queuedToEdit)?.editing === true &&
                messageByText(messages, externalReply)?.pendingDelivery === 'queue',
            'An external reply overwrote the queued message being edited instead of joining the queue.'
        );
        assertPendingOrder(state, [queuedToEdit, externalReply]);
        const draftAfterExternalReply = (await (await editorElement()).getText()).trim();
        assertVisible(
            draftAfterExternalReply === draftBeforeExternalReply,
            `An external reply cleared the draft while editing. Expected ${JSON.stringify(
                draftBeforeExternalReply
            )}, received ${JSON.stringify(draftAfterExternalReply)}.`
        );

        await discardQueueAndCancelRequest();
        releaseAnswer.resolve();
    });

    it('user can expand a long queued message without moving it away from the bottom', async () => {
        const releaseAnswer = deferred();
        const longQueuedMessage = Array.from(
            { length: 12 },
            (_, index) => `Long queued line ${index + 1} ${'detail '.repeat(8)}`
        ).join('\n');

        server.planNext(async ({ stream }) => {
            stream.text('Waiting for a long queued message.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });

        await startRunningTurn(server);
        const { state: collapsedState, message } = await submitWhileRunning(
            longQueuedMessage,
            'enter',
            'queue',
            1
        );
        assertQueuedMessage(message);
        assertVisible(
            message.collapsed && message.hasExpandToggle && message.expanded === 'false',
            `The long queued message did not start collapsed: ${JSON.stringify(message)}.`
        );
        assertVisible(
            message.lineClamp === '6' && message.textScrollHeight > message.textClientHeight,
            `The long queued message was not visibly clamped: ${JSON.stringify(message)}.`
        );
        assertVisible(
            collapsedState[collapsedState.length - 1].id === message.id,
            'The long queued message was not the bottom row before expanding.'
        );

        await clickMessageAction(message, 'user-message-expand-toggle');
        const expandedState = await waitForConversation((messages) => {
            const expanded = messageByText(messages, longQueuedMessage);
            return expanded?.collapsed === false && expanded.expanded === 'true';
        }, 'Clicking the expand control did not reveal the full queued message.');
        assertQueuedMessage(messageByText(expandedState, longQueuedMessage));
        const expandedMessage = messageByText(expandedState, longQueuedMessage);
        assertVisible(
            expandedMessage.lineClamp === 'none' &&
                expandedMessage.textScrollHeight <= expandedMessage.textClientHeight + 1,
            `Expanding did not reveal the complete queued message: ${JSON.stringify(
                expandedMessage
            )}.`
        );
        assertVisible(
            expandedState[expandedState.length - 1].id === message.id,
            'Expanding the long queued message moved it out of the bottom position.'
        );

        await discardQueueAndCancelRequest();
        releaseAnswer.resolve();
    });

    it('user gets the swapped bindings when queue and steer shortcuts are exchanged', async () => {
        const releaseAnswer = deferred();
        const queuedWithModifiedEnter = 'Queued with the modified chord';
        const steeredWithEnter = 'Steered with plain Enter';

        await callE2eBridge('setSearchKeybindings', SWAPPED_SHORTCUTS);
        server.planNext(async ({ stream }) => {
            stream.text('Holding the answer for swapped shortcuts.');
            await releaseAnswer.promise;
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(queuedWithModifiedEnter, 'modified', 'queue', 1);
        await submitWhileRunning(steeredWithEnter, 'enter', 'priority', 2);

        const state = await readConversationMessages();
        assertPendingOrder(state, [steeredWithEnter, queuedWithModifiedEnter]);
        assertSolidSteer(messageByText(state, steeredWithEnter));
        assertQueuedMessage(messageByText(state, queuedWithModifiedEnter));

        await discardQueueAndCancelRequest();
        releaseAnswer.resolve();
    });

    it('user keeps the queue after cancelling a turn and can keep chatting afterwards', async () => {
        const releaseCancelledAnswer = deferred();
        const releaseFirstQueuedAnswer = deferred();
        const queuedOne = 'First queue kept by cancellation';
        const queuedTwo = 'Second queue kept by cancellation';
        const promptAfterQueue = 'Prompt submitted after cancellation';

        server.planNext(async ({ stream }) => {
            stream.text('Answer cancelled by the user.');
            await releaseCancelledAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(async ({ stream }) => {
            stream.text('Answer for the first queue preserved by cancellation.');
            await releaseFirstQueuedAnswer.promise;
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer for the second queue preserved by cancellation.');
            stream.finish('stop');
        });
        server.planNext(({ stream }) => {
            stream.text('Answer after the preserved queue drained.');
            stream.finish('stop');
        });

        await startRunningTurn(server);
        await submitWhileRunning(queuedOne, 'enter', 'queue', 1);
        await submitWhileRunning(queuedTwo, 'enter', 'queue', 2);
        await pressEditorKey('\uE00C');
        releaseCancelledAnswer.resolve();

        await server.waitForRequestCount(2);
        assertLatestUserText(server.requests[1], queuedOne);
        const afterCancel = await waitForConversation(
            (state) =>
                messageByText(state, queuedOne)?.pendingDelivery === null &&
                messageByText(state, queuedTwo)?.pendingDelivery === 'queue' &&
                Boolean(loadingMessage(state)),
            'Cancelling the run discarded the queue instead of starting its first message.'
        );
        assertQueuedMessage(messageByText(afterCancel, queuedTwo));

        releaseFirstQueuedAnswer.resolve();
        await server.waitForRequestCount(3);
        assertLatestUserText(server.requests[2], queuedTwo);
        await waitForConversation(
            (state) => pendingMessages(state).length === 0 && !loadingMessage(state),
            'The queue preserved by cancellation did not drain.'
        );

        await fillSearchDraft(promptAfterQueue);
        await submitSearchDraft('enter');
        await server.waitForRequestCount(4);
        assertLatestUserText(server.requests[3], promptAfterQueue);
        await waitForConversation(
            (state) => !loadingMessage(state) && pendingMessages(state).length === 0,
            'A new prompt could not complete after the preserved queue drained.'
        );
    });
});

function loadedBeforeQueued(state) {
    const queued = pendingMessages(state).filter((message) => message.pendingDelivery === 'queue');
    return queued.length === 2;
}
