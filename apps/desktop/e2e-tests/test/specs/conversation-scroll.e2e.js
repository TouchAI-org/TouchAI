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
import {
    sampleConversationNavigation,
    targetExcursionAfterArrival,
} from '../support/conversation-navigation.js';
import {
    assertVisible,
    callE2eBridge,
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
            mountedMessages: viewport.querySelectorAll('[data-message-id]').length,
        };
    });
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
    // One frame for the scroll listener, one for the virtualizer to re-measure.
    await browser.pause(400);
}

function distanceFromBottom(state) {
    return state.scrollHeight - state.scrollTop - state.clientHeight;
}

describe('user scrolls a long conversation', () => {
    before(async () => {
        await waitForE2eBridge();
        await useInterfaceLanguage();
        await useProductFont();
    });

    after(async () => {
        // Leave the app empty so the specs that follow stay independent.
        await callE2eBridge('setConversation', []);
        await browser.pause(300);
    });

    it('user sees the newest message when a long conversation opens', async () => {
        await callE2eBridge('setConversation', buildConversation());

        await browser.setWindowSize(750, 620);
        await waitForTestIdDisplayed('conversation-panel-host');
        await browser.pause(1200);

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
        await browser.pause(800);

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

    it('user gets the newest message again after scrolling back to the bottom', async () => {
        const current = await readScrollState();
        await scrollViewportTo(current.scrollHeight);

        const afterScroll = await readScrollState();
        assertVisible(
            distanceFromBottom(afterScroll) <= BOTTOM_TOLERANCE_PX,
            'Scrolling to the end did not reach the newest message.'
        );

        // Following is on again, so the next answer stays in view.
        await callE2eBridge('setConversation', buildConversation(2));
        await browser.pause(800);

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
        await browser.pause(900);

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
        await browser.pause(1500);

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

        await browser.pause(1200);
        const settled = await readQuestionOffset();
        assertVisible(
            settled === null || settled < before - 100,
            'The viewport returned to the selected question after user scrolling.'
        );
    });
});
