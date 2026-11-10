/**
 * User flows: the main window in the states a person actually meets.
 *
 * The first spec only covers the empty search window, which is the least
 * interesting screen in the app: once a conversation starts, the window grows and
 * the layout is completely different. These baselines capture those states so a
 * token or spacing change in the conversation panel, the search results or the
 * ask-user panel shows up as an image diff instead of reaching a user.
 *
 * The transcript and the pending request come from the app's E2E bridge. A real
 * model call would make the pixels depend on a network response, and the point of
 * a baseline is that a difference means the code changed.
 */
import assert from 'node:assert/strict';

import {
    assertVisible,
    callE2eBridge,
    expectSearchSurfaceSnapshot,
    resetSearchSurface,
    useInterfaceLanguage,
    useProductFont,
    useSearchFixture,
    waitForE2eBridge,
    waitForTestIdDisplayed,
    waitForTestIdNotDisplayed,
} from '../support/desktop.js';
import { APPROVAL_REQUEST, SEARCH_FIXTURE_QUERY } from '../support/fixtures.js';

const ASSISTANT_ANSWER = [
    'The migration replaced bespoke scanners with standard tooling:',
    '',
    '1. Tokens moved into `@theme`, so colour, radius and type come from one place.',
    '2. Lint rules now reject arbitrary values and palette utilities in new code.',
    '3. Visual baselines record the main window and the settings screens.',
].join('\n');

/**
 * A finished exchange, shaped exactly like the app's own `SessionMessage`.
 *
 * `parts` is the source of truth for what the panel renders — `content` alone is
 * not enough — so both are filled in. Getting this wrong produces a message bubble
 * with its toolbar but no text, which is a bug the baseline would happily record.
 */
const CONVERSATION_FIXTURE = [
    {
        id: 'e2e-user-1',
        role: 'user',
        content: 'Summarize the design system migration in three bullet points.',
        parts: [
            {
                id: 'e2e-user-1-part-1',
                type: 'text',
                content: 'Summarize the design system migration in three bullet points.',
            },
        ],
        timestamp: 1_760_000_000_000,
    },
    {
        id: 'e2e-assistant-1',
        role: 'assistant',
        content: ASSISTANT_ANSWER,
        parts: [
            {
                id: 'e2e-assistant-1-part-1',
                type: 'text',
                content: ASSISTANT_ANSWER,
            },
        ],
        timestamp: 1_760_000_001_000,
    },
];

describe('user works in the main window with a conversation', () => {
    before(async () => {
        await waitForE2eBridge();
        await useInterfaceLanguage();
        await useProductFont();
        // Registered here rather than inside one case, because the panel has to answer
        // the same way for every spec that opens it.
        await useSearchFixture();
    });

    beforeEach(resetSearchSurface);
    afterEach(resetSearchSurface);

    it('user sees the search results panel keep its layout while typing', async () => {
        // A query no real file matches: the bridge answers for it from the fixture this
        // spec registered, so the pixels do not depend on what happens to be on this
        // machine's disk.
        await browser.execute(
            (query) => window.__TOUCHAI_E2E__.setSearchQuery(query),
            SEARCH_FIXTURE_QUERY
        );

        const panel = await waitForTestIdDisplayed('quick-search-panel');
        await browser.pause(700);

        assertVisible(await panel.isDisplayed(), 'The results panel was not visible.');
        await expectSearchSurfaceSnapshot('main-window-search-results');

        await browser.execute(() => window.__TOUCHAI_E2E__.setSearchQuery(''));
        await waitForTestIdNotDisplayed('quick-search-panel');
    });

    it('user sees the conversation panel with a finished answer', async () => {
        await callE2eBridge('setConversation', CONVERSATION_FIXTURE);

        // Natural content measurement owns the card height and its native envelope.
        await waitForTestIdDisplayed('conversation-panel-host');
        await browser.pause(1200);

        await expectSearchSurfaceSnapshot('main-window-conversation');
    });

    it('user sees a warm message bubble and white file attachment when reopening a conversation', async () => {
        await callE2eBridge('setConversation', [
            {
                ...CONVERSATION_FIXTURE[0],
                attachments: [
                    {
                        id: 'appearance-file',
                        type: 'file',
                        name: 'Report.pdf',
                        path: '/fixture/Report.pdf',
                        originPath: '/fixture/Report.pdf',
                    },
                ],
            },
        ]);
        await waitForTestIdDisplayed('conversation-panel-host');
        await $('[data-message-id="e2e-user-1"] .user-text').waitForDisplayed();
        await $('[data-testid="search-editor-host"]').moveTo();

        const palette = await browser.execute(() => {
            const message = document.querySelector('[data-message-id="e2e-user-1"]');
            const text = message.querySelector('.user-text');
            const file = [...message.querySelectorAll('span')].find(
                (element) => element.textContent.trim() === 'Report.pdf'
            );
            const context = document.createElement('canvas').getContext('2d');
            const rootStyle = getComputedStyle(document.documentElement);
            const rgb = (value) => {
                context.fillStyle = value;
                context.fillRect(0, 0, 1, 1);
                return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };

            return {
                actual: {
                    bubble: rgb(getComputedStyle(text.parentElement.parentElement).backgroundColor),
                    text: rgb(getComputedStyle(text).color),
                    attachment: rgb(getComputedStyle(file.parentElement).backgroundColor),
                    filename: rgb(getComputedStyle(file).color),
                    copy: rgb(getComputedStyle(message.querySelector('button')).color),
                },
                expected: {
                    bubble: [235, 231, 227],
                    text: rgb(rootStyle.getPropertyValue('--color-gray-900')),
                    attachment: [255, 255, 255],
                    filename: rgb(rootStyle.getPropertyValue('--color-gray-700')),
                    copy: rgb(rootStyle.getPropertyValue('--color-gray-400')),
                },
            };
        });

        assert.deepEqual(palette.actual, palette.expected);
    });

    it('user sees the ask-user panel when a tool needs a decision', async () => {
        await callE2eBridge('setConversation', CONVERSATION_FIXTURE);
        await callE2eBridge('setAskUserRequest', APPROVAL_REQUEST);

        const panel = await waitForTestIdDisplayed('ask-user-panel');
        await browser.pause(800);

        assertVisible(await panel.isDisplayed(), 'The ask-user panel was not visible.');
        const layout = await browser.execute(() => {
            const card = document.querySelector('[data-testid="search-view-card"]');
            const cardBounds = card.getBoundingClientRect();
            const toolbar = card.querySelector('.toolbar-fade-overlay').getBoundingClientRect();
            const approval = card
                .querySelector('[data-testid="ask-user-panel"]')
                .getBoundingClientRect();
            return {
                cardHeight: cardBounds.height,
                cardScroll: card.scrollTop,
                toolbarTop: toolbar.top - cardBounds.top,
                approvalTop: approval.top - cardBounds.top,
                approvalBottom: approval.bottom - cardBounds.bottom,
            };
        });
        assertVisible(
            layout.cardScroll === 0 &&
                layout.toolbarTop >= 0 &&
                layout.approvalTop >= 0 &&
                layout.approvalBottom <= 1,
            `The toolbar and complete approval must fit inside the card: ${JSON.stringify(layout)}`
        );
        await expectSearchSurfaceSnapshot('main-window-ask-user');
    });
});
