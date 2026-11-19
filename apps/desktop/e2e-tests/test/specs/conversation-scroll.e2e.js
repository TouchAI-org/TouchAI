/**
 * User flows: scrolling a long conversation.
 *
 * Every message in a conversation is expensive to render (markdown, tool cards,
 * widgets), so the panel only mounts the ones near the viewport and keeps a spacer
 * for the rest. That makes three behaviours load-bearing, and all three have
 * regressed before:
 *
 * - opening a conversation lands at the newest message, not the first one;
 * - scrolling up stops the panel from following the stream;
 * - jumping from the navigation rail reaches a message that is not mounted.
 *
 * The baseline specs cannot catch these: a screenshot shows one viewport, and the
 * bugs live in how the scroll position moves between states. These cases assert the
 * viewport geometry instead, so they survive a restyle.
 */
import { createAgentStreamServer, deferred } from '../support/agent-stream.js';
import {
    sampleConversationNavigation,
    targetExcursionAfterArrival,
} from '../support/conversation-navigation.js';
import {
    fillSearchDraft,
    loadingMessage,
    submitSearchDraft,
    waitForConversation,
} from '../support/conversation-queue.js';
import {
    assertVisible,
    callE2eBridge,
    resetSearchSurface,
    useInterfaceLanguage,
    useProductFont,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

const MESSAGE_COUNT = 40;
const BOTTOM_TOLERANCE_PX = 8;
const JUMPED_AWAY_LIMIT_PX = 400;

/**
 * A transcript long enough to overflow the window.
 *
 * The text is repeated rather than randomised: a baseline is not involved here, but a
 * deterministic height keeps the jump assertions meaningful across runs.
 */
function buildConversation(extraAssistantMessages = 0) {
    const messages = [];
    for (let index = 0; index < MESSAGE_COUNT; index += 1) {
        const role = index % 2 === 0 ? 'user' : 'assistant';
        const content = `${role === 'user' ? 'Question' : 'Answer'} ${index + 1}: ${'detail '.repeat(
            12
        )}`;
        messages.push({
            id: `e2e-scroll-${index}`,
            role,
            content,
            parts: [{ id: `e2e-scroll-${index}-part`, type: 'text', content }],
            timestamp: 1_760_000_000_000 + index,
        });
    }

    for (let index = 0; index < extraAssistantMessages; index += 1) {
        const content = `Late answer ${index + 1}: ${'more detail '.repeat(12)}`;
        messages.push({
            id: `e2e-scroll-late-${index}`,
            role: 'assistant',
            content,
            parts: [
                {
                    id: `e2e-scroll-late-${index}-part`,
                    type: 'text',
                    content,
                },
            ],
            timestamp: 1_760_000_100_000 + index,
        });
    }

    return messages;
}

/** Scroll geometry of the message viewport, read from the page. */
async function readScrollState() {
    return browser.execute(() => {
        const viewport = document.querySelector(
            '[data-slot="message-scroller"] section[aria-label]'
        );
        if (!viewport) {
            return null;
        }

        return {
            scrollTop: viewport.scrollTop,
            scrollHeight: viewport.scrollHeight,
            clientHeight: viewport.clientHeight,
            clientWidth: viewport.clientWidth,
            mountedMessages: viewport.querySelectorAll('[data-message-id]').length,
            animations:
                document.querySelector('[data-testid="search-view-card"]')?.getAnimations()
                    .length ?? 0,
        };
    });
}

async function waitForConversationLayout() {
    let previous = '';
    let stableSince = Date.now();
    await browser.waitUntil(
        async () => {
            const state = await readScrollState();
            const signature = JSON.stringify(state);
            if (
                !state ||
                state.clientHeight === 0 ||
                state.animations > 0 ||
                signature !== previous
            ) {
                previous = signature;
                stableSince = Date.now();
                return false;
            }
            return Date.now() - stableSince >= 500;
        },
        { interval: 50, timeoutMsg: 'The conversation viewport did not finish settling.' }
    );
}

async function scrollViewportTo(scrollTop) {
    await browser.execute((top) => {
        const viewport = document.querySelector(
            '[data-slot="message-scroller"] section[aria-label]'
        );
        if (viewport) {
            viewport.scrollTop = top;
        }
    }, scrollTop);
    await waitForConversationLayout();
}

function distanceFromBottom(state) {
    return state.scrollHeight - state.scrollTop - state.clientHeight;
}

describe('user scrolls a long conversation', () => {
    before(async () => {
        await waitForE2eBridge();
        await useInterfaceLanguage();
        await useProductFont();
        await resetSearchSurface();
    });

    beforeEach(async () => {
        await resetSearchSurface();
        await callE2eBridge('setConversation', buildConversation());
        await waitForTestIdDisplayed('conversation-panel-host');
        await waitForConversationLayout();
    });

    after(async () => {
        // Leave the app empty so the specs that follow stay independent.
        await resetSearchSurface();
    });

    it('user sees the newest message when a long conversation opens', async () => {
        const state = await readScrollState();

        assertVisible(state !== null, 'The message viewport was not found.');
        assertVisible(
            distanceFromBottom(state) <= BOTTOM_TOLERANCE_PX,
            `The conversation did not open at the newest message: ${JSON.stringify(state)}.`
        );
        // The panel must not mount the whole transcript; that is what makes a long
        // session with heavy tool output stall for seconds.
        assertVisible(
            state.mountedMessages < MESSAGE_COUNT,
            `Every message was mounted (${state.mountedMessages}), so windowing is not active.`
        );
    });

    it('user keeps their reading position when a streamed answer arrives', async () => {
        const before = await readScrollState();
        const readingPosition = Math.min(200, Math.max(0, before.scrollTop));

        await scrollViewportTo(readingPosition);
        const scrolled = await readScrollState();
        assertVisible(
            distanceFromBottom(scrolled) > JUMPED_AWAY_LIMIT_PX,
            'The test could not scroll away from the newest message.'
        );

        // A new answer arrives while the user is reading older text.
        await callE2eBridge('setConversation', buildConversation(1));
        await waitForConversationLayout();

        const after = await readScrollState();

        assertVisible(
            Math.abs(after.scrollTop - scrolled.scrollTop) <= 40,
            `The panel jumped while the user was reading: ${scrolled.scrollTop} -> ${after.scrollTop}.`
        );
        assertVisible(
            distanceFromBottom(after) > BOTTOM_TOLERANCE_PX,
            'The panel followed the new answer even though the user had scrolled up.'
        );
    });

    it('user gets the newest message again after using the scroll-to-latest control', async () => {
        await scrollViewportTo(200);
        const scrollToLatest = await $('button[aria-label="Scroll to latest message"]');
        await scrollToLatest.waitForClickable();
        await scrollToLatest.click();
        await waitForConversationLayout();

        const afterScroll = await readScrollState();
        assertVisible(
            distanceFromBottom(afterScroll) <= BOTTOM_TOLERANCE_PX,
            'Scrolling to the end did not reach the newest message.'
        );

        // Following is on again, so the next answer stays in view.
        await callE2eBridge('setConversation', buildConversation(2));
        await waitForConversationLayout();

        const afterStream = await readScrollState();
        assertVisible(
            distanceFromBottom(afterStream) <= BOTTOM_TOLERANCE_PX,
            `The panel stopped following after the user returned to the bottom: ${JSON.stringify(afterStream)}.`
        );
    });

    it('user can jump to the oldest message from the navigation rail', async () => {
        const before = await readScrollState();
        assertVisible(
            distanceFromBottom(before) <= BOTTOM_TOLERANCE_PX,
            'This case expects the panel to start at the newest message.'
        );

        // The rail is the only way to reach a message that is scrolled far away: its
        // dots are index-based, so the target is almost certainly not mounted.
        const railDots = await browser.$$('[data-slot="message-scroller-rail"] button');
        assertVisible(railDots.length > 0, 'The message navigation rail was empty.');
        await railDots[0].click();
        await waitForConversationLayout();

        const after = await readScrollState();

        assertVisible(
            after.scrollTop < before.scrollTop - JUMPED_AWAY_LIMIT_PX,
            `Jumping to the oldest message did not move the viewport: ${before.scrollTop} -> ${after.scrollTop}.`
        );
        assertVisible(
            after.mountedMessages < MESSAGE_COUNT,
            `Jumping mounted the whole transcript (${after.mountedMessages}) instead of a window.`
        );
    });

    it('user sees a selected question stay in place while long answers finish mounting', async () => {
        const messages = buildConversation().map((message, index) => {
            if (message.role === 'user') return message;
            const content = Array.from(
                { length: 40 + (index % 5) * 8 },
                (_, paragraph) =>
                    `Paragraph ${paragraph + 1}: ${'Detailed explanation. '.repeat(12)}`
            ).join('\n\n');
            return {
                ...message,
                content,
                parts: [{ id: `${message.id}-part`, type: 'text', content }],
            };
        });
        await callE2eBridge('setConversation', messages);
        await waitForTestIdDisplayed('conversation-panel-host');
        await waitForConversationLayout();

        const reducedMotion = await browser.execute(
            () => matchMedia('(prefers-reduced-motion: reduce)').matches
        );
        console.info(`[navigation] prefers-reduced-motion: ${reducedMotion}`);

        for (const index of [4, 14, 4, 4]) {
            const samples = await sampleConversationNavigation(index, `e2e-scroll-${index * 2}`);
            const excursion = targetExcursionAfterArrival(samples);
            const changedFrames = samples.filter(
                (sample, frame) =>
                    frame === 0 ||
                    sample.top !== samples[frame - 1].top ||
                    sample.afterLayout.top !== sample.top
            );
            assertVisible(
                excursion <= 2,
                `Question ${index} moved after arriving (${excursion}px); changed frames: ${JSON.stringify(changedFrames.slice(0, 16))}.`
            );
            assertVisible(
                samples.every((sample) => sample.mountedMessages < messages.length),
                `Navigation mounted the entire conversation (${Math.max(...samples.map((sample) => sample.mountedMessages))}/${messages.length}).`
            );
        }
    });

    it('user can keep scrolling after selecting a question', async () => {
        await sampleConversationNavigation(4, 'e2e-scroll-8');
        const viewport = await browser.$('[data-slot="message-scroller"] section[aria-label]');
        await viewport.click();
        const readQuestionOffset = () =>
            browser.execute(() => {
                const viewport = document.querySelector('[data-slot="message-scroller"] section');
                const question = viewport.querySelector('[data-message-id="e2e-scroll-8"]');
                return question
                    ? question.getBoundingClientRect().top - viewport.getBoundingClientRect().top
                    : null;
            });
        const before = await readQuestionOffset();
        assertVisible(before !== null, 'The selected question was not mounted.');
        await browser.keys('PageDown');
        await browser.waitUntil(
            async () => {
                const offset = await readQuestionOffset();
                return offset === null || offset < before - 100;
            },
            {
                timeout: 5000,
                timeoutMsg: 'The selected question held the viewport against user scrolling.',
            }
        );

        await waitForConversationLayout();
        const settled = await readQuestionOffset();
        assertVisible(
            settled === null || settled < before - 100,
            'The viewport returned to the selected question after user scrolling.'
        );
    });

    it('user maximizes a conversation and reads a centered column above a full-width input', async () => {
        await (await browser.$('button[aria-label="Maximize window"]')).click();
        const restore = await browser.$('button[aria-label="Restore window"]');
        try {
            await restore.waitForDisplayed();
            for (const count of [2, MESSAGE_COUNT]) {
                await callE2eBridge('setConversation', buildConversation().slice(0, count));
                await browser.waitUntil(
                    () =>
                        browser.execute(() => {
                            const input = document.querySelector('[data-testid="search-bar"]');
                            const viewport = document.querySelector(
                                '[data-slot="message-scroller"] section'
                            );
                            const message = viewport?.querySelector('[data-message-id]');
                            if (!input || !viewport || !message) return false;
                            const panel = viewport.getBoundingClientRect();
                            const row = message.getBoundingClientRect();
                            const style = getComputedStyle(viewport);
                            const available =
                                panel.width -
                                parseFloat(style.paddingLeft) -
                                parseFloat(style.paddingRight);
                            return (
                                Math.abs(row.width - Math.min(880, available)) < 1 &&
                                (available <= 880 ||
                                    Math.abs(row.left + row.right - panel.left - panel.right) <
                                        2) &&
                                Math.abs(input.getBoundingClientRect().width - panel.width) < 1
                            );
                        }),
                    { timeoutMsg: `Unexpected message or input geometry with ${count} messages.` }
                );
            }
        } finally {
            await restore.click();
        }
    });
});

async function wheelConversation(deltaY) {
    const point = await browser.execute(() => {
        const viewport = document.querySelector(
            '[data-slot="message-scroller"] section[aria-label]'
        );
        const rect = viewport.getBoundingClientRect();
        window.__e2eConversationWheel = null;
        viewport.addEventListener(
            'wheel',
            (event) => {
                window.__e2eConversationWheel = { trusted: event.isTrusted, deltaY: event.deltaY };
            },
            { once: true }
        );
        return {
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2),
        };
    });
    await browser.performActions([
        {
            type: 'wheel',
            id: 'conversation-reading-wheel',
            actions: [
                { type: 'scroll', origin: 'viewport', ...point, deltaX: 0, deltaY, duration: 0 },
            ],
        },
    ]);
    await browser.releaseActions();
    await browser.waitUntil(
        () => browser.execute(() => window.__e2eConversationWheel?.trusted === true),
        { timeoutMsg: 'The conversation did not receive a real wheel gesture.' }
    );
}

describe('user reads earlier text while a real answer continues streaming', () => {
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
        await callE2eBridge('setSearchKeybindings', { 'search.submit.queue': 'Enter' });
    });

    afterEach(async () => {
        await callE2eBridge('clearPendingSearchMessages');
        await callE2eBridge('cancelSearchRequest');
        await resetSearchSurface();
        await browser.execute(() => delete window.__e2eConversationWheel);
        server.reset();
    });

    after(async () => {
        await server.close();
    });

    for (const distance of [8, 64]) {
        it(`user scrolls up ${distance} pixels and keeps that position until returning to the newest text`, async () => {
            const finishAnswer = deferred();
            let activeStream;
            const paragraph = `${'Streaming answer detail. '.repeat(12)}\n\n`;
            server.planNext(async ({ stream }) => {
                activeStream = stream;
                stream.text(paragraph.repeat(30));
                await finishAnswer.promise;
                stream.finish();
            });

            await fillSearchDraft(`Read during a stream with a ${distance} pixel wheel`);
            await submitSearchDraft('enter');
            await server.waitForRequestCount(1);
            await waitForConversation(
                (state) => Boolean(loadingMessage(state)),
                'The real streaming answer did not start.'
            );
            await browser.waitUntil(
                async () => {
                    const state = await readScrollState();
                    return state && state.scrollTop > 500 && distanceFromBottom(state) <= 2;
                },
                { timeoutMsg: 'The streaming answer did not overflow and settle at the bottom.' }
            );
            await waitForConversationLayout();
            const before = await readScrollState();
            assertVisible(
                distanceFromBottom(before) <= 2,
                'The settled streaming answer did not remain at the live edge.'
            );
            await wheelConversation(-distance);
            await browser.waitUntil(
                async () => (await readScrollState()).scrollTop < before.scrollTop - 2,
                { timeoutMsg: 'A small upward wheel did not move the reading position.' }
            );
            const reading = await readScrollState();

            for (let index = 0; index < 5; index += 1) {
                const beforeChunk = await readScrollState();
                activeStream.text(`Continued paragraph ${index + 1}. ${paragraph.repeat(2)}`);
                await browser.waitUntil(
                    async () =>
                        (await readScrollState()).scrollHeight > beforeChunk.scrollHeight + 20,
                    { timeoutMsg: 'The model chunk did not increase the real answer height.' }
                );
                const afterChunk = await readScrollState();
                assertVisible(
                    Math.abs(afterChunk.scrollTop - reading.scrollTop) <= 2,
                    `The stream pulled the user back after a ${distance}px wheel: ${reading.scrollTop} -> ${afterChunk.scrollTop}.`
                );
            }
            const continued = await readScrollState();
            assertVisible(
                distanceFromBottom(continued) > 400,
                'The answer did not grow while the user read earlier text.'
            );

            await wheelConversation(continued.scrollHeight);
            await browser.waitUntil(async () => distanceFromBottom(await readScrollState()) <= 2, {
                timeoutMsg: 'Scrolling down did not reach the newest text.',
            });
            const following = await readScrollState();
            activeStream.text(`Text after returning to the bottom. ${paragraph.repeat(2)}`);
            await browser.waitUntil(
                async () => {
                    const state = await readScrollState();
                    return (
                        state.scrollHeight > following.scrollHeight + 20 &&
                        distanceFromBottom(state) <= 2
                    );
                },
                { timeoutMsg: 'Following did not resume after returning to the bottom.' }
            );
            finishAnswer.resolve();
            await waitForConversation(
                (state) => !loadingMessage(state),
                'The streaming answer did not finish.'
            );
            assertVisible(
                server.requests.length === 1 && server.protocolError === null,
                'The scroll gesture restarted the model request.'
            );
        });
    }
});
